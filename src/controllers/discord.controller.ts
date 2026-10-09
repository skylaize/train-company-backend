import { Request, Response } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma";
import { AuthRequest } from "../middleware/auth.middleware";
import { APP_ID, botEnabled, BRAND_COLOR, Embed, esc, fmt, GUILD_ID, PUBLIC_KEY, rest } from "../services/discord.service";
import { clearRoles, syncUser } from "../services/discord-roles.service";
import { BOARDS, BoardId, buildLeaderRows, rankRows } from "../services/leaderboard.service";
import { allianceRanking, ALLIANCE_MAX } from "../services/alliance.service";
import { currentSeason, DIVISIONS } from "../services/saison.service";

/* ============================================================
   Discord (2.1) : liaison du compte et commandes slash.

   Liaison : Paramètres → « Lier mon Discord ». Discord demande au joueur
   l'autorisation (identify + guilds.join) ; au retour, on retient son
   identifiant, on l'ajoute au serveur s'il n'y est pas encore, et on lui
   donne ses rôles.

   Commandes slash : Discord appelle POST /api/discord/interactions, signé
   en Ed25519 avec la clé publique de l'application. On répond « en cours »
   tout de suite (Discord n'attend que 3 secondes) puis on modifie la
   réponse une fois le calcul fait.
   ============================================================ */

const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const JWT_SECRET = process.env.JWT_SECRET as string;
const STATE_SECRET = `${JWT_SECRET}:discord-link`;
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || "").replace(/\/$/, "");
const SITE_URL = (process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
const redirectUri = () => `${API_PUBLIC_URL}/api/discord/callback`;

function linkEnabled() {
  return botEnabled() && Boolean(APP_ID && CLIENT_SECRET && API_PUBLIC_URL && SITE_URL);
}

/* ---------------- liaison ---------------- */

export async function discordStatus(req: AuthRequest, res: Response) {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { discordId: true, discordName: true } });
  return res.json({ enabled: linkEnabled(), linked: Boolean(user?.discordId), name: user?.discordName ?? null });
}

export function discordLinkStart(req: AuthRequest, res: Response) {
  if (!linkEnabled()) return res.status(503).json({ error: "La liaison Discord n'est pas encore ouverte" });
  const state = jwt.sign({ u: req.userId, n: crypto.randomBytes(8).toString("hex") }, STATE_SECRET, { expiresIn: "10m" });
  const q = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "identify guilds.join",
    state,
    prompt: "consent",
  });
  return res.json({ url: `https://discord.com/oauth2/authorize?${q}` });
}

function backToGame(res: Response, params: Record<string, string>) {
  return res.redirect(`${SITE_URL}/dashboard?${new URLSearchParams(params)}`);
}

export async function discordCallback(req: Request, res: Response) {
  if (!linkEnabled()) return res.status(404).send("Liaison indisponible");
  if (req.query.error) return backToGame(res, { discord: "annule" });
  let userId: string;
  try {
    userId = (jwt.verify(String(req.query.state ?? ""), STATE_SECRET) as { u: string }).u;
  } catch {
    return backToGame(res, { discord: "erreur", raison: "La demande a expiré, réessayez" });
  }
  try {
    const t = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: APP_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(req.query.code ?? ""),
        redirect_uri: redirectUri(),
      }),
    });
    const { access_token } = (await t.json()) as { access_token?: string };
    if (!t.ok || !access_token) return backToGame(res, { discord: "erreur", raison: "Discord a refusé la liaison" });

    const me = (await (await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${access_token}` } })).json()) as {
      id?: string; username?: string; global_name?: string | null;
    };
    if (!me.id) return backToGame(res, { discord: "erreur", raison: "Compte Discord introuvable" });

    const taken = await prisma.user.findUnique({ where: { discordId: me.id }, select: { id: true } });
    if (taken && taken.id !== userId) {
      return backToGame(res, { discord: "erreur", raison: "Ce compte Discord est déjà lié à une autre compagnie" });
    }
    await prisma.user.update({ where: { id: userId }, data: { discordId: me.id, discordName: me.global_name || me.username || null } });

    // ajoute le joueur au serveur s'il n'y est pas encore (sans effet s'il y est déjà)
    await rest("PUT", `/guilds/${GUILD_ID}/members/${me.id}`, { body: { access_token } }).catch((err) =>
      console.error("[discord] ajout au serveur :", (err as Error).message)
    );
    await syncUser(userId).catch((err) => console.error("[discord] rôles :", (err as Error).message));
    return backToGame(res, { discord: "ok" });
  } catch (err) {
    console.error("[discord] liaison :", (err as Error).message);
    return backToGame(res, { discord: "erreur", raison: "Liaison impossible pour le moment" });
  }
}

export async function discordUnlink(req: AuthRequest, res: Response) {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { discordId: true } });
  if (user?.discordId) await clearRoles(user.discordId).catch(() => undefined);
  await prisma.user.update({ where: { id: req.userId }, data: { discordId: null, discordName: null } });
  return res.json({ ok: true });
}

/* Avant la suppression d'un compte : rôles retirés, rien d'autre à faire. */
export async function forgetDiscord(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { discordId: true } });
  if (user?.discordId) await clearRoles(user.discordId).catch(() => undefined);
}

/* ---------------- commandes slash ---------------- */

const BOARD_CHOICES = [
  ...BOARDS.map((b) => ({ name: b.label, value: b.id })),
  { name: "Saison", value: "saison" },
  { name: "Alliances", value: "alliances" },
];

export const COMMANDS = [
  {
    name: "profil",
    description: "La compagnie d'un joueur : valeur, flotte, saison, alliance",
    options: [{ type: 6, name: "joueur", description: "Le joueur (vous par défaut)", required: false }],
  },
  {
    name: "classement",
    description: "Le top 10 d'un classement du jeu",
    options: [{ type: 3, name: "tableau", description: "Quel classement", required: false, choices: BOARD_CHOICES }],
  },
  {
    name: "alliance",
    description: "Une alliance : membres, points, rang",
    options: [{ type: 3, name: "nom", description: "Le nom de l'alliance (la vôtre par défaut)", required: false }],
  },
  { name: "lier", description: "Lier votre compte Réseau à Discord pour recevoir vos rôles" },
];

/* Au démarrage : déclare les commandes sur le serveur (remplace l'ancienne
   liste, ce qui les met à jour instantanément). */
export async function registerDiscordCommands() {
  if (!botEnabled() || !APP_ID) return;
  try {
    await rest("PUT", `/applications/${APP_ID}/guilds/${GUILD_ID}/commands`, { body: COMMANDS });
    console.log("[discord] commandes slash à jour");
  } catch (err) {
    console.error("[discord] commandes slash :", (err as Error).message);
  }
}

// la clé publique Ed25519 de Discord, en hexadécimal, enveloppée au format attendu par Node
let verifyKey: crypto.KeyObject | null = null;
function publicKey() {
  if (!verifyKey && PUBLIC_KEY) {
    verifyKey = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(PUBLIC_KEY, "hex")]),
      format: "der",
      type: "spki",
    });
  }
  return verifyKey;
}

export function verifyDiscordSignature(body: Buffer, signature: string, timestamp: string) {
  const key = publicKey();
  if (!key || !signature || !timestamp) return false;
  try {
    return crypto.verify(null, Buffer.concat([Buffer.from(timestamp, "utf8"), body]), key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

type Interaction = {
  type: number;
  token: string;
  data?: { name: string; options?: { name: string; value: string }[]; resolved?: { users?: Record<string, { username: string; global_name?: string | null }> } };
  member?: { user: { id: string } };
  user?: { id: string };
};

/* Monté AVANT express.json() : la signature porte sur les octets bruts. */
export async function discordInteractions(req: Request, res: Response) {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !verifyDiscordSignature(body, String(req.headers["x-signature-ed25519"] ?? ""), String(req.headers["x-signature-timestamp"] ?? ""))) {
    return res.status(401).send("signature invalide");
  }
  const i = JSON.parse(body.toString("utf8")) as Interaction;
  if (i.type === 1) return res.json({ type: 1 }); // PING de vérification

  if (i.type !== 2 || !i.data) return res.status(400).end();
  const callerId = i.member?.user.id ?? i.user?.id ?? "";
  const opt = (name: string) => i.data?.options?.find((o) => o.name === name)?.value;

  if (i.data.name === "lier") {
    return res.json({
      type: 4,
      data: {
        flags: 64, // visible par vous seul
        content: SITE_URL
          ? `Ouvrez **Paramètres** dans le jeu et cliquez sur **Lier mon Discord** : ${SITE_URL}/dashboard`
          : "Ouvrez **Paramètres** dans le jeu et cliquez sur **Lier mon Discord**.",
      },
    });
  }

  // « réfléchit… » tout de suite, la vraie réponse suit
  res.json({ type: 5 });
  try {
    let reply: { content?: string; embeds?: Embed[] };
    if (i.data.name === "profil") reply = await profileReply(opt("joueur") ?? callerId, callerId);
    else if (i.data.name === "classement") reply = await boardReply(opt("tableau") ?? "valeur");
    else if (i.data.name === "alliance") reply = await allianceReply(opt("nom"), callerId);
    else reply = { content: "Commande inconnue." };
    await rest("PATCH", `/webhooks/${APP_ID}/${i.token}/messages/@original`, { bot: false, body: { ...reply, allowed_mentions: { parse: [] } } });
  } catch (err) {
    console.error("[discord] commande", i.data.name, ":", (err as Error).message);
    await rest("PATCH", `/webhooks/${APP_ID}/${i.token}/messages/@original`, { bot: false, body: { content: "Le réseau ne répond pas, réessayez dans un instant." } }).catch(() => undefined);
  }
}

async function companyOfDiscord(discordId: string) {
  const user = await prisma.user.findUnique({ where: { discordId }, select: { company: { select: { id: true, name: true, liveryColor: true, isPremium: true, title: true, createdAt: true } } } });
  return user?.company ?? null;
}

const colorOf = (hex: string | null | undefined) => {
  const n = parseInt(String(hex ?? "").replace("#", ""), 16);
  return Number.isFinite(n) ? n : BRAND_COLOR;
};

async function profileReply(discordId: string, callerId: string) {
  const company = await companyOfDiscord(discordId);
  if (!company) {
    return {
      content:
        discordId === callerId
          ? "Votre compte Discord n'est pas encore lié. Tapez **/lier** pour savoir comment faire."
          : "Ce joueur n'a pas lié son compte Réseau à Discord.",
    };
  }
  const ranked = rankRows(await buildLeaderRows(), "valeur");
  const row = ranked.find((r) => r.id === company.id);
  const fields: NonNullable<Embed["fields"]> = [];
  if (row) {
    fields.push(
      { name: "Grade", value: row.grade, inline: true },
      { name: "Valeur", value: `${fmt(row.valeur)} pi. · #${row.rank}/${ranked.length}`, inline: true },
      { name: "Flotte", value: `${row.trains} rame${row.trains > 1 ? "s" : ""} · ${row.lines} ligne${row.lines > 1 ? "s" : ""}`, inline: true }
    );
  }
  const season = await currentSeason();
  if (season) {
    const entry = await prisma.seasonEntry.findUnique({ where: { seasonId_companyId: { seasonId: season.id, companyId: company.id } } });
    if (entry) {
      const ahead = await prisma.seasonEntry.count({ where: { seasonId: season.id, division: entry.division, groupNo: entry.groupNo, points: { gt: entry.points } } });
      fields.push({ name: season.name, value: `${DIVISIONS[entry.division]} · groupe ${entry.groupNo} · **${ahead + 1}e** · ${fmt(entry.points)} pts`, inline: false });
    }
  }
  const member = await prisma.allianceMember.findUnique({ where: { companyId: company.id } });
  if (member) {
    const alliance = await prisma.alliance.findUnique({ where: { id: member.allianceId }, select: { name: true, founderId: true } });
    if (alliance) fields.push({ name: "Alliance", value: `${esc(alliance.name)}${alliance.founderId === company.id ? " (chef)" : ""}`, inline: true });
  }
  if (company.isPremium) fields.push({ name: "Statut", value: "💎 Premium", inline: true });
  return {
    embeds: [
      {
        title: company.name,
        description: company.title ? `*${esc(company.title)}*` : undefined,
        color: colorOf(company.liveryColor),
        fields,
        footer: { text: `Compagnie fondée le ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(company.createdAt)}` },
      },
    ],
  };
}

async function boardReply(board: string) {
  const medal = (i: number) => ["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`;
  if (board === "alliances") {
    const list = (await allianceRanking()).slice(0, 10);
    return {
      embeds: [{
        title: "Classement des alliances",
        description: list.length ? list.map((a, i) => `${medal(i)} **${esc(a.name)}** — ${fmt(a.points)} pts · ${a.members}/${ALLIANCE_MAX}`).join("\n") : "Aucune alliance pour l'instant.",
        color: BRAND_COLOR,
      }],
    };
  }
  const rows = await buildLeaderRows();
  if (board === "saison") {
    const season = await currentSeason();
    if (!season) return { content: "Aucune saison en cours." };
    const entries = (await prisma.seasonEntry.findMany({ where: { seasonId: season.id, points: { gt: 0 } }, orderBy: { points: "desc" }, take: 10 })) as { companyId: string; points: number; division: number }[];
    const names = new Map(rows.map((r) => [r.id, r.name]));
    return {
      embeds: [{
        title: season.name,
        description: entries.length ? entries.map((e, i) => `${medal(i)} **${esc(names.get(e.companyId) ?? "—")}** — ${fmt(e.points)} pts · ${DIVISIONS[e.division]}`).join("\n") : "Aucun point marqué pour l'instant.",
        color: BRAND_COLOR,
      }],
    };
  }
  const meta = BOARDS.find((b) => b.id === board) ?? BOARDS[0];
  const top = rankRows(rows, meta.id as BoardId).slice(0, 10);
  const value = (r: (typeof top)[number]) => `${fmt(r[meta.id])}${meta.unit ? ` ${meta.unit}` : ""}`;
  return {
    embeds: [{
      title: `Classement — ${meta.label}`,
      description: top.length ? top.map((r, i) => `${medal(i)} **${esc(r.name)}** — ${value(r)}`).join("\n") : meta.missing,
      color: BRAND_COLOR,
      footer: { text: meta.note },
    }],
  };
}

async function allianceReply(name: string | undefined, callerId: string) {
  let alliance: { id: string; name: string; color: string; founderId: string; discordUrl: string | null } | null = null;
  if (name) {
    alliance = await prisma.alliance.findFirst({ where: { name: { equals: name.trim(), mode: "insensitive" } } });
    if (!alliance) return { content: `Aucune alliance ne s'appelle « ${esc(name.trim())} ».` };
  } else {
    const company = await companyOfDiscord(callerId);
    if (!company) return { content: "Précisez un nom d'alliance, ou liez votre compte avec **/lier**." };
    const m = await prisma.allianceMember.findUnique({ where: { companyId: company.id } });
    if (m) alliance = await prisma.alliance.findUnique({ where: { id: m.allianceId } });
    if (!alliance) return { content: "Vous n'êtes dans aucune alliance. Précisez un nom pour en voir une." };
  }
  const [members, ranking, season] = await Promise.all([
    prisma.allianceMember.findMany({ where: { allianceId: alliance.id }, orderBy: { joinedAt: "asc" } }) as Promise<{ companyId: string }[]>,
    allianceRanking(),
    currentSeason(),
  ]);
  const ids = members.map((m) => m.companyId);
  const [companies, entries] = await Promise.all([
    prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) as Promise<{ id: string; name: string }[]>,
    season ? (prisma.seasonEntry.findMany({ where: { seasonId: season.id, companyId: { in: ids } }, select: { companyId: true, points: true } }) as Promise<{ companyId: string; points: number }[]>) : Promise.resolve([]),
  ]);
  const names = new Map(companies.map((c) => [c.id, c.name]));
  const pts = new Map(entries.map((e) => [e.companyId, e.points]));
  const rank = ranking.find((r) => r.id === alliance!.id);
  return {
    embeds: [{
      title: alliance.name,
      url: alliance.discordUrl ?? undefined,
      color: colorOf(alliance.color),
      description: rank ? `**${rank.rank}e** sur ${ranking.length} alliances · ${fmt(rank.points)} pts cette saison` : "Pas encore de points cette saison.",
      fields: [{
        name: `Membres (${members.length}/${ALLIANCE_MAX})`,
        value: members.map((m) => `${m.companyId === alliance!.founderId ? "👑" : "•"} ${esc(names.get(m.companyId) ?? "—")} — ${fmt(pts.get(m.companyId) ?? 0)} pts`).join("\n") || "—",
      }],
    }],
  };
}
