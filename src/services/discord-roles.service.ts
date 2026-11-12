import { prisma } from "../prisma";
import { botEnabled, DiscordError, GUILD_ID, guildRoleList, managedRoleIds, ManagedRole, rest } from "./discord.service";
import { DIVISION_ROLES } from "./discord-provision.service";
import { syncAllianceSpaces } from "./discord-alliances.service";
import { lastMonthChampions } from "./discord-quiz.service";
import { recordBoost } from "./boost.service";
import { voteRoleHolders } from "./vote.service";

/* ============================================================
   Rôles automatiques (2.1).

   Pour chaque joueur qui a lié son compte Discord :
   - 🚉 Joueur            : il a fondé sa compagnie ;
   - 💎 Premium           : sa compagnie est Premium ;
   - 🤝 Chef d'alliance   : il a fondé (ou hérité) une alliance ;
   - 🏆 Champion de saison : premier de son groupe à la dernière saison close ;
   - 🗳️ Voteur du mois    : sur le podium des votes Top-Serveurs du mois dernier.

   2.8 : s'y ajoutent le rôle de sa division de saison (🥉 Bronze, 🥈 Argent,
   🥇 Or, 💠 Platine) et le rôle « ⚑ Nom » de son alliance, qui ouvre le
   salon privé de l'alliance (voir discord-alliances.service).

   Le jeu ne touche qu'à ces rôles : ceux du staff, les rôles de
   notification et tout ce qui est ajouté à la main restent intacts.

   Synchronisation : au moment de la liaison, à l'achat du Premium, et un
   passage complet toutes les cinq minutes pour le reste.
   ============================================================ */

type Linked = { id: string; discordId: string; companyId: string | null; isPremium: boolean; division: number };

async function context() {
  const [founders, lastSeason, voters, quizChamps, allianceMembers, spaces, roleList] = await Promise.all([
    prisma.alliance.findMany({ select: { founderId: true } }) as Promise<{ founderId: string }[]>,
    prisma.season.findFirst({ where: { endedAt: { not: null } }, orderBy: { number: "desc" }, select: { id: true } }),
    voteRoleHolders().catch(() => new Set<string>()),
    lastMonthChampions().catch(() => new Set<string>()),
    prisma.allianceMember.findMany({ select: { allianceId: true, companyId: true } }) as Promise<{ allianceId: string; companyId: string }[]>,
    (prisma.discordAllianceSpace.findMany({ select: { allianceId: true, roleId: true } }) as Promise<{ allianceId: string; roleId: string }[]>).catch(() => []),
    guildRoleList(),
  ]);
  const spaceRole = new Map<string, string>(spaces.map((s) => [s.allianceId, s.roleId] as [string, string]));
  const champions = lastSeason
    ? ((await prisma.seasonEntry.findMany({
        where: { seasonId: lastSeason.id, finalRank: 1, points: { gt: 0 } },
        select: { companyId: true },
      })) as { companyId: string }[])
    : [];
  return {
    founders: new Set(founders.map((f) => f.founderId)),
    champions: new Set(champions.map((c) => c.companyId)),
    voters,
    quizChamps, // 2.8 : 🧠 Champion du quiz
    // 2.8 : rôles de division (dans l'ordre Bronze → Platine, "" si le rôle manque) et d'alliance
    divisionRoles: DIVISION_ROLES.map((d) => roleList.find((r) => r.name === d.name)?.id ?? ""),
    allianceRoles: [...spaceRole.values()],
    allianceRoleOf: new Map(allianceMembers.filter((m) => spaceRole.has(m.allianceId)).map((m) => [m.companyId, spaceRole.get(m.allianceId) as string])),
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
  if (ctx.voters.has(u.companyId)) out.add("VOTEUR");
  if (ctx.quizChamps.has(u.discordId)) out.add("QUIZ");
  return out;
}

/* 2.8 : les rôles créés par le bot (division, alliance). Pour chacun, vrai
   si le joueur doit l'avoir. */
function wantedExtra(u: Linked, ctx: Ctx) {
  const out = new Map<string, boolean>();
  ctx.divisionRoles.forEach((id, i) => {
    if (id) out.set(id, Boolean(u.companyId) && u.division === i);
  });
  const mine = u.companyId ? ctx.allianceRoleOf.get(u.companyId) : undefined;
  for (const id of ctx.allianceRoles) out.set(id, id === mine);
  return out;
}

/* Ajoute et retire ce qu'il faut. Renvoie false si la personne n'est pas
   (ou plus) sur le serveur. */
async function apply(discordId: string, want: Set<ManagedRole>, roleIds: Map<ManagedRole, string>, extra: Map<string, boolean> = new Map()) {
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
  for (const [roleId, wantIt] of extra) {
    if (wantIt && !has.has(roleId)) {
      await rest("PUT", `/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`, { reason: "Réseau : division et alliance" });
    } else if (!wantIt && has.has(roleId)) {
      await rest("DELETE", `/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`, { reason: "Réseau : division et alliance" });
    }
  }
  return true;
}

async function linkedUsers(where: { id?: string } = {}): Promise<Linked[]> {
  const rows = (await prisma.user.findMany({
    where: { ...where, discordId: { not: null } },
    select: { id: true, discordId: true, company: { select: { id: true, isPremium: true, division: true } } },
  })) as { id: string; discordId: string | null; company: { id: string; isPremium: boolean; division: number } | null }[];
  return rows.map((r) => ({ id: r.id, discordId: r.discordId!, companyId: r.company?.id ?? null, isPremium: r.company?.isPremium ?? false, division: r.company?.division ?? 0 }));
}

/* Un joueur, tout de suite (liaison, achat du Premium). */
export async function syncUser(userId: string) {
  if (!botEnabled()) return;
  const [u] = await linkedUsers({ id: userId });
  if (!u) return;
  const [ctx, roleIds] = await Promise.all([context(), managedRoleIds()]);
  await apply(u.discordId, wanted(u, ctx), roleIds, wantedExtra(u, ctx));
}

export async function syncCompany(companyId: string) {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { ownerId: true } });
  if (c) await syncUser(c.ownerId);
}

/* Tout le monde : appelé par la simulation toutes les cinq minutes. */
export async function syncAllRoles() {
  if (!botEnabled()) return;
  // 2.8 : d'abord les espaces d'alliance (rôles et salons), pour que leurs rôles soient distribués dans la foulée
  await syncAllianceSpaces().catch((err) => console.error("[discord] espaces d'alliance :", (err as Error).message));
  const [users, ctx, roleIds] = await Promise.all([linkedUsers(), context(), managedRoleIds()]);
  for (const u of users) {
    try {
      await apply(u.discordId, wanted(u, ctx), roleIds, wantedExtra(u, ctx));
    } catch (err) {
      console.error("[discord] rôles de", u.id, ":", (err as Error).message);
    }
  }
}

/* Délier (ou supprimer le compte) : on retire les rôles du jeu. */
export async function clearRoles(discordId: string) {
  if (!botEnabled()) return;
  const [roleIds, ctx] = await Promise.all([managedRoleIds(), context()]);
  // plus de compagnie liée : ni rôle du jeu, ni division, ni alliance
  await apply(discordId, new Set(), roleIds, wantedExtra({ id: "", discordId, companyId: null, isPremium: false, division: 0 }, ctx));
}
