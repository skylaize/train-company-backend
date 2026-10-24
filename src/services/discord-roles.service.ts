import { prisma } from "../prisma";
import { botEnabled, DiscordError, GUILD_ID, managedRoleIds, ManagedRole, rest } from "./discord.service";
import { recordBoost } from "./boost.service";

/* ============================================================
   Rôles automatiques (2.1).

   Pour chaque joueur qui a lié son compte Discord :
   - 🚉 Joueur            : il a fondé sa compagnie ;
   - 💎 Premium           : sa compagnie est Premium ;
   - 🤝 Chef d'alliance   : il a fondé (ou hérité) une alliance ;
   - 🏆 Champion de saison : premier de son groupe à la dernière saison close.

   Le jeu ne touche qu'à ces quatre rôles : ceux du staff, les rôles de
   notification et tout ce qui est ajouté à la main restent intacts.

   Synchronisation : au moment de la liaison, à l'achat du Premium, et un
   passage complet toutes les cinq minutes pour le reste.
   ============================================================ */

type Linked = { id: string; discordId: string; companyId: string | null; isPremium: boolean };

async function context() {
  const [founders, lastSeason] = await Promise.all([
    prisma.alliance.findMany({ select: { founderId: true } }) as Promise<{ founderId: string }[]>,
    prisma.season.findFirst({ where: { endedAt: { not: null } }, orderBy: { number: "desc" }, select: { id: true } }),
  ]);
  const champions = lastSeason
    ? ((await prisma.seasonEntry.findMany({
        where: { seasonId: lastSeason.id, finalRank: 1, points: { gt: 0 } },
        select: { companyId: true },
      })) as { companyId: string }[])
    : [];
  return {
    founders: new Set(founders.map((f) => f.founderId)),
    champions: new Set(champions.map((c) => c.companyId)),
  };
}
type Ctx = Awaited<ReturnType<typeof context>>;

function wanted(u: Linked, ctx: Ctx): Set<ManagedRole> {
  const out = new Set<ManagedRole>();
  if (!u.companyId) return out;
  out.add("JOUEUR");
  if (u.isPremium) out.add("PREMIUM");
  if (ctx.founders.has(u.companyId)) out.add("CHEF");
  if (ctx.champions.has(u.companyId)) out.add("CHAMPION");
  return out;
}

/* Ajoute et retire ce qu'il faut. Renvoie false si la personne n'est pas
   (ou plus) sur le serveur. */
async function apply(discordId: string, want: Set<ManagedRole>, roleIds: Map<ManagedRole, string>) {
  let member: { roles: string[]; premium_since?: string | null } | null;
  try {
    member = await rest<{ roles: string[]; premium_since?: string | null }>("GET", `/guilds/${GUILD_ID}/members/${discordId}`);
  } catch (err) {
    if (err instanceof DiscordError && err.status === 404) {
      await recordBoost(discordId, null).catch(() => undefined); // parti du serveur : plus de boost
      return false;
    }
    throw err;
  }
  // 2.3 : le boost Nitro, lu au passage
  await recordBoost(discordId, member?.premium_since ? new Date(member.premium_since) : null).catch((err) => console.error("[discord] boost :", (err as Error).message));
  const has = new Set(member?.roles ?? []);
  for (const [key, roleId] of roleIds) {
    if (want.has(key) && !has.has(roleId)) {
      await rest("PUT", `/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`, { reason: "Réseau : synchronisation du compte" });
    } else if (!want.has(key) && has.has(roleId)) {
      await rest("DELETE", `/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`, { reason: "Réseau : synchronisation du compte" });
    }
  }
  return true;
}

async function linkedUsers(where: { id?: string } = {}): Promise<Linked[]> {
  const rows = (await prisma.user.findMany({
    where: { ...where, discordId: { not: null } },
    select: { id: true, discordId: true, company: { select: { id: true, isPremium: true } } },
  })) as { id: string; discordId: string | null; company: { id: string; isPremium: boolean } | null }[];
  return rows.map((r) => ({ id: r.id, discordId: r.discordId!, companyId: r.company?.id ?? null, isPremium: r.company?.isPremium ?? false }));
}

/* Un joueur, tout de suite (liaison, achat du Premium). */
export async function syncUser(userId: string) {
  if (!botEnabled()) return;
  const [u] = await linkedUsers({ id: userId });
  if (!u) return;
  const [ctx, roleIds] = await Promise.all([context(), managedRoleIds()]);
  await apply(u.discordId, wanted(u, ctx), roleIds);
}

export async function syncCompany(companyId: string) {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { ownerId: true } });
  if (c) await syncUser(c.ownerId);
}

/* Tout le monde : appelé par la simulation toutes les cinq minutes. */
export async function syncAllRoles() {
  if (!botEnabled()) return;
  const [users, ctx, roleIds] = await Promise.all([linkedUsers(), context(), managedRoleIds()]);
  for (const u of users) {
    try {
      await apply(u.discordId, wanted(u, ctx), roleIds);
    } catch (err) {
      console.error("[discord] rôles de", u.id, ":", (err as Error).message);
    }
  }
}

/* Délier (ou supprimer le compte) : on retire les rôles du jeu. */
export async function clearRoles(discordId: string) {
  if (!botEnabled()) return;
  const roleIds = await managedRoleIds();
  await apply(discordId, new Set(), roleIds);
}
