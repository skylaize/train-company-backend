import { prisma } from "../prisma";
import { APP_ID, botEnabled, DiscordError, forgetGuildCache, GUILD_ID, guildChannels, guildRoleList, rest } from "./discord.service";
import { P, TYPE } from "./discord-provision.service";

/* ============================================================
   Espaces d'alliance (2.8).

   Dès que deux membres d'une alliance ont lié leur compte Discord, le bot
   lui ouvre un rôle « ⚑ Nom » et un salon privé, visible de ses seuls
   membres (et du staff, pour la modération). Le rôle suit les arrivées et
   les départs comme les autres rôles du jeu, toutes les cinq minutes.

   Alliance renommée : rôle et salon suivent. Nouveau chef : il reçoit le
   droit d'épingler et de supprimer dans le salon. Alliance dissoute :
   rôle et salon sont supprimés.

   Les salons sont rangés dans des catégories « 🤝 ALLIANCES PRIVÉES »
   (Discord limite une catégorie à 50 salons ; une deuxième est ouverte au
   besoin).
   ============================================================ */

const CATEGORY = "🤝 ALLIANCES PRIVÉES";
const MIN_LINKED = 2;
const MAX_NEW_PER_PASS = 5; // pour ne pas buter sur les limites de débit de Discord
const bits = (...p: bigint[]) => String(p.reduce((a, b) => a | b, 0n));

const MEMBER_ALLOW = bits(P.VIEW, P.SEND, P.EMBED, P.ATTACH, P.HISTORY, P.ADD_REACTIONS, P.CREATE_THREADS, P.SEND_IN_THREADS);
const CHIEF_ALLOW = bits(P.VIEW, P.MANAGE_MESSAGES, P.MANAGE_THREADS);
const MOD_ALLOW = bits(P.VIEW, P.SEND, P.HISTORY, P.MANAGE_MESSAGES);
const BOT_ALLOW = bits(P.VIEW, P.SEND, P.EMBED, P.HISTORY, P.MANAGE_MESSAGES);

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const roleNameOf = (alliance: string) => `⚑ ${alliance}`.slice(0, 100);
const channelNameOf = (alliance: string) => `🤝・${norm(alliance).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "alliance"}`.slice(0, 90);
const colorOf = (hex: string) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return Number.isFinite(n) ? n : 0;
};

type Space = { allianceId: string; roleId: string; channelId: string; name: string; founderDiscordId: string };
type AllianceRow = { id: string; name: string; color: string; founderId: string };

async function overwrites(roleId: string, founderDiscordId: string) {
  const mods = (await guildRoleList()).filter((r) => /(^|[^a-z])(moderateurs?|moderation|support)([^a-z]|$)/.test(norm(r.name)));
  return [
    { id: GUILD_ID, type: 0, deny: bits(P.VIEW) },
    { id: roleId, type: 0, allow: MEMBER_ALLOW },
    ...mods.map((r) => ({ id: r.id, type: 0, allow: MOD_ALLOW })),
    ...(APP_ID ? [{ id: APP_ID, type: 1, allow: BOT_ALLOW }] : []),
    ...(founderDiscordId ? [{ id: founderDiscordId, type: 1, allow: CHIEF_ALLOW }] : []),
  ];
}

/* Une catégorie où il reste de la place, créée au besoin. */
async function freeCategory() {
  const channels = await guildChannels(true);
  const cats = channels.filter((c) => c.type === TYPE.CATEGORY && c.name.startsWith(CATEGORY));
  for (const cat of cats) {
    if (channels.filter((c) => c.parent_id === cat.id).length < 50) return cat.id;
  }
  const created = await rest<{ id: string }>("POST", `/guilds/${GUILD_ID}/channels`, {
    reason: "Réseau : salons d'alliance",
    body: { name: cats.length ? `${CATEGORY} ${cats.length + 1}` : CATEGORY, type: TYPE.CATEGORY, permission_overwrites: [{ id: GUILD_ID, type: 0, deny: bits(P.VIEW) }] },
  });
  return created!.id;
}

async function createSpace(a: AllianceRow, founderDiscordId: string, linked: number) {
  const role = await rest<{ id: string }>("POST", `/guilds/${GUILD_ID}/roles`, {
    reason: `Réseau : alliance ${a.name}`,
    body: { name: roleNameOf(a.name), color: colorOf(a.color), hoist: false, mentionable: false, permissions: "0" },
  });
  let channel: { id: string } | null = null;
  try {
    channel = await rest<{ id: string }>("POST", `/guilds/${GUILD_ID}/channels`, {
      reason: `Réseau : alliance ${a.name}`,
      body: {
        name: channelNameOf(a.name),
        type: TYPE.TEXT,
        parent_id: await freeCategory(),
        topic: `Salon privé de l'alliance ${a.name}. Seuls ses membres qui ont lié leur compte le voient.`,
        permission_overwrites: await overwrites(role!.id, founderDiscordId),
      },
    });
  } catch (err) {
    // pas de salon : on ne laisse pas un rôle orphelin derrière
    await rest("DELETE", `/guilds/${GUILD_ID}/roles/${role!.id}`).catch(() => undefined);
    throw err;
  }
  await prisma.discordAllianceSpace.create({ data: { allianceId: a.id, roleId: role!.id, channelId: channel!.id, name: a.name, founderDiscordId } });
  await rest("POST", `/channels/${channel!.id}/messages`, {
    body: {
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: `⚑ ${a.name}`,
          color: colorOf(a.color),
          description: [
            "Bienvenue dans le salon privé de votre alliance.",
            "",
            `Il n'est visible que de vos membres qui ont lié leur compte Discord (${linked} pour l'instant) et du staff du serveur.`,
            "Les autres le rejoignent tout seuls dès qu'ils lient leur compte : Paramètres → **Lier mon Discord** dans le jeu.",
            "",
            "**/alliance** affiche vos points et votre rang · le chef peut épingler les messages importants.",
          ].join("\n"),
        },
      ],
    },
  }).catch(() => undefined);
  console.log(`[discord] espace d'alliance ouvert : ${a.name}`);
}

async function removeSpace(s: Space) {
  for (const path of [`/channels/${s.channelId}`, `/guilds/${GUILD_ID}/roles/${s.roleId}`]) {
    await rest("DELETE", path, { reason: "Réseau : alliance dissoute" }).catch((err) => {
      if (!(err instanceof DiscordError) || err.status !== 404) throw err;
    });
  }
  await prisma.discordAllianceSpace.delete({ where: { allianceId: s.allianceId } });
  console.log(`[discord] espace d'alliance fermé : ${s.name}`);
}

/* Un passage : ouvre, renomme et ferme ce qu'il faut. Appelé juste avant
   la synchronisation des rôles, qui distribue ensuite les rôles d'alliance. */
export async function syncAllianceSpaces() {
  if (!botEnabled()) return;
  const [alliances, members, spaces] = await Promise.all([
    prisma.alliance.findMany({ select: { id: true, name: true, color: true, founderId: true } }) as Promise<AllianceRow[]>,
    prisma.allianceMember.findMany({ select: { allianceId: true, companyId: true } }) as Promise<{ allianceId: string; companyId: string }[]>,
    prisma.discordAllianceSpace.findMany() as Promise<Space[]>,
  ]);
  const linked = (await prisma.company.findMany({
    where: { id: { in: members.map((m) => m.companyId) }, owner: { discordId: { not: null } } },
    select: { id: true, owner: { select: { discordId: true } } },
  })) as { id: string; owner: { discordId: string | null } }[];
  const discordOf = new Map(linked.map((c) => [c.id, c.owner.discordId as string]));
  const linkedCount = new Map<string, number>();
  for (const m of members) if (discordOf.has(m.companyId)) linkedCount.set(m.allianceId, (linkedCount.get(m.allianceId) ?? 0) + 1);

  const byId = new Map(alliances.map((a) => [a.id, a]));
  const spaceOf = new Map(spaces.map((s) => [s.allianceId, s]));
  let changed = false;

  // alliances dissoutes (garde-fou : jamais de ménage si la liste revient vide)
  if (alliances.length) {
    for (const s of spaces) {
      if (byId.has(s.allianceId)) continue;
      await removeSpace(s).catch((err) => console.error("[discord] fermeture de l'espace", s.name, ":", (err as Error).message));
      changed = true;
    }
  }

  // renommées, ou nouveau chef
  for (const s of spaces) {
    const a = byId.get(s.allianceId);
    if (!a) continue;
    const founder = discordOf.get(a.founderId) ?? "";
    if (a.name === s.name && founder === s.founderDiscordId) continue;
    try {
      if (a.name !== s.name) await rest("PATCH", `/guilds/${GUILD_ID}/roles/${s.roleId}`, { body: { name: roleNameOf(a.name) } });
      await rest("PATCH", `/channels/${s.channelId}`, { body: { name: channelNameOf(a.name), permission_overwrites: await overwrites(s.roleId, founder) } });
      await prisma.discordAllianceSpace.update({ where: { allianceId: s.allianceId }, data: { name: a.name, founderDiscordId: founder } });
      changed = true;
    } catch (err) {
      console.error("[discord] mise à jour de l'espace", a.name, ":", (err as Error).message);
    }
  }

  // nouvelles
  let created = 0;
  for (const a of alliances) {
    if (spaceOf.has(a.id) || (linkedCount.get(a.id) ?? 0) < MIN_LINKED) continue;
    if (created >= MAX_NEW_PER_PASS) break;
    try {
      await createSpace(a, discordOf.get(a.founderId) ?? "", linkedCount.get(a.id) ?? 0);
      created++;
      changed = true;
    } catch (err) {
      console.error("[discord] ouverture de l'espace", a.name, ":", (err as Error).message);
      if (err instanceof DiscordError && err.status === 403) break; // permission manquante : inutile d'insister
    }
  }
  if (changed) forgetGuildCache();
}
