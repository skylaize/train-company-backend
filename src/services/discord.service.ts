import { prisma } from "../prisma";

/* ============================================================
   Discord (2.1) — le lien entre le jeu et le serveur Discord officiel.

   Tout passe par l'API REST de Discord, sans connexion permanente au
   « gateway » : pas de processus en plus à faire tourner, et rien ne
   casse pendant un déploiement quand deux conteneurs cohabitent. Les
   commandes slash arrivent elles aussi en HTTP (voir discord.controller).

   Les rôles et salons sont retrouvés PAR LEUR NOM (ceux que crée le script
   de mise en place du serveur) : aucun identifiant à recopier dans .env.
   Renommer un rôle ou un salon dans Discord ? Mettre le nouveau nom ici.

   Tant que DISCORD_BOT_TOKEN ou DISCORD_GUILD_ID manque, tout ce module
   reste silencieux : le jeu tourne exactement comme avant.
   ============================================================ */

export const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
export const GUILD_ID = process.env.DISCORD_GUILD_ID || "";
export const APP_ID = process.env.DISCORD_CLIENT_ID || "";
export const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || "";

export const ROLES = {
  JOUEUR: "🚉 Joueur",
  PREMIUM: "💎 Premium",
  CHEF: "🤝 Chef d'alliance",
  CHAMPION: "🏆 Champion de saison",
} as const;
export type ManagedRole = keyof typeof ROLES;

// 2.1 : rôles de notification, choisis par les membres à l'arrivée (onboarding)
export const NOTIFY_ROLES = {
  MAJ: "🔔 Mises à jour",
  EVENEMENTS: "🔔 Événements",
} as const;
export type NotifyRole = keyof typeof NOTIFY_ROLES;

export const CHANNELS = {
  ANNONCES: "📣・annonces",
  PATCH_NOTES: "🛠️・patch-notes",
  SAISONS: "🏆・saisons",
  CLASSEMENTS: "📊・classements",
  CHANTIER: "🏔️・grand-chantier",
  LOGS: "📋・logs",
} as const;
export type ChannelKey = keyof typeof CHANNELS;

export const BRAND_COLOR = 0xf2a900;

export function botEnabled() {
  return Boolean(BOT_TOKEN && GUILD_ID);
}

/* ---------------- REST ---------------- */

export class DiscordError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type RestOptions = { body?: unknown; bot?: boolean; reason?: string };

/* Un appel à l'API. Un 429 (limite de débit) est attendu puis rejoué une
   fois ; au-delà on abandonne, le tour suivant retentera. */
export async function rest<T = unknown>(method: string, path: string, opts: RestOptions = {}): Promise<T | null> {
  const headers: Record<string, string> = {};
  if (opts.bot !== false) headers.Authorization = `Bot ${BOT_TOKEN}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(opts.reason);
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`https://discord.com/api/v10${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 429 && attempt === 0) {
      const data = (await r.json().catch(() => ({}))) as { retry_after?: number };
      await new Promise((ok) => setTimeout(ok, Math.min(10_000, Math.ceil((data.retry_after ?? 1) * 1000))));
      continue;
    }
    if (r.status === 204) return null;
    const text = await r.text();
    if (!r.ok) throw new DiscordError(r.status, `${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
    return text ? (JSON.parse(text) as T) : null;
  }
  throw new DiscordError(429, `${method} ${path} → limite de débit`);
}

/* ---------------- rôles et salons, par leur nom ---------------- */

const CACHE_MS = 10 * 60_000;
let rolesCache: { at: number; byName: Map<string, string> } | null = null;
let channelsCache: { at: number; byName: Map<string, string> } | null = null;
const warned = new Set<string>();

function warnOnce(key: string, msg: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[discord] ${msg}`);
}

async function guildRoles() {
  if (rolesCache && Date.now() - rolesCache.at < CACHE_MS) return rolesCache.byName;
  const roles = (await rest<{ id: string; name: string }[]>("GET", `/guilds/${GUILD_ID}/roles`)) ?? [];
  rolesCache = { at: Date.now(), byName: new Map(roles.map((r) => [r.name, r.id])) };
  return rolesCache.byName;
}

/* Les identifiants des rôles gérés par le jeu ; un rôle introuvable est
   simplement ignoré (et signalé une fois dans les journaux). */
export async function managedRoleIds() {
  const byName = await guildRoles();
  const out = new Map<ManagedRole, string>();
  for (const key of Object.keys(ROLES) as ManagedRole[]) {
    const id = byName.get(ROLES[key]);
    if (id) out.set(key, id);
    else warnOnce(`role:${key}`, `rôle « ${ROLES[key]} » introuvable sur le serveur`);
  }
  return out;
}

/* La mention d'un rôle de notification, à ajouter en tête d'une annonce. */
async function rolePing(key: NotifyRole): Promise<MessagePayload> {
  const id = (await guildRoles()).get(NOTIFY_ROLES[key]);
  if (!id) {
    warnOnce(`role:${key}`, `rôle « ${NOTIFY_ROLES[key]} » introuvable sur le serveur`);
    return {};
  }
  return { content: `<@&${id}>`, allowed_mentions: { parse: [], roles: [id] } as MessagePayload["allowed_mentions"] };
}

export async function channelId(key: ChannelKey) {
  if (!channelsCache || Date.now() - channelsCache.at >= CACHE_MS) {
    const list = (await rest<{ id: string; name: string }[]>("GET", `/guilds/${GUILD_ID}/channels`)) ?? [];
    channelsCache = { at: Date.now(), byName: new Map(list.map((c) => [c.name, c.id])) };
  }
  const id = channelsCache.byName.get(CHANNELS[key]);
  if (!id) warnOnce(`channel:${key}`, `salon « ${CHANNELS[key]} » introuvable sur le serveur`);
  return id ?? null;
}

/* ---------------- messages ---------------- */

export type Embed = {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  author?: { name: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string }; // 2.1.2 : la grande image de l'annonce des 200
  footer?: { text: string };
  timestamp?: string;
};
export type MessagePayload = { content?: string; embeds?: Embed[]; allowed_mentions?: { parse: string[]; roles?: string[] } };

// jamais de @everyone ou de mention surprise venue d'un nom de compagnie
const SAFE = { allowed_mentions: { parse: [] as string[] } };

/* Échappe le markdown de Discord dans un texte venu des joueurs. */
export function esc(s: string) {
  return s.replace(/([\\*_`~|>])/g, "\\$1");
}

export const fmt = (n: number) => new Intl.NumberFormat("fr-FR").format(Math.round(n));

async function send(channel: string, payload: MessagePayload) {
  const msg = await rest<{ id: string }>("POST", `/channels/${channel}/messages`, { body: { ...SAFE, ...payload } });
  return msg!.id;
}

/* Publie une seule fois un message (ou une suite de messages) identifié par
   sa clé. Dans un salon d'annonces, il est aussi « publié » vers les serveurs
   qui suivent le salon. Renvoie false s'il l'était déjà. */
export async function postOnce(key: string, channelKey: ChannelKey, payloads: MessagePayload[], opts: { crosspost?: boolean; ping?: NotifyRole } = {}) {
  if (!botEnabled() || payloads.length === 0) return false;
  if (await prisma.discordPost.findUnique({ where: { key } })) return false;
  const channel = await channelId(channelKey);
  if (!channel) return false;
  /* La clé est prise AVANT d'envoyer : si deux conteneurs passent ici en même
     temps (déploiement), un seul gagne l'insertion. */
  try {
    await prisma.discordPost.create({ data: { key, channelId: channel, messageId: "" } });
  } catch {
    return false;
  }
  try {
    let first = "";
    // la mention ne part qu'avec le premier message d'une annonce en plusieurs parties
    if (opts.ping) payloads = [{ ...payloads[0], ...(await rolePing(opts.ping)) }, ...payloads.slice(1)];
    for (const p of payloads) {
      const id = await send(channel, p);
      if (!first) first = id;
      if (opts.crosspost) await rest("POST", `/channels/${channel}/messages/${id}/crosspost`).catch(() => undefined);
    }
    await prisma.discordPost.update({ where: { key }, data: { messageId: first } });
    return true;
  } catch (err) {
    // échec : on libère la clé pour que le tour suivant retente
    await prisma.discordPost.delete({ where: { key } }).catch(() => undefined);
    throw err;
  }
}

/* Marque une clé comme déjà publiée sans rien envoyer. */
export async function markPosted(key: string) {
  await prisma.discordPost.upsert({ where: { key }, create: { key, channelId: "", messageId: "" }, update: {} });
}

/* Un message tenu à jour : modifié sur place, ou republié s'il a disparu. */
export async function upsertPost(key: string, channelKey: ChannelKey, payload: MessagePayload) {
  if (!botEnabled()) return;
  const channel = await channelId(channelKey);
  if (!channel) return;
  const existing = await prisma.discordPost.findUnique({ where: { key } });
  if (existing && existing.channelId === channel && existing.messageId) {
    try {
      await rest("PATCH", `/channels/${channel}/messages/${existing.messageId}`, { body: { ...SAFE, ...payload } });
      return;
    } catch (err) {
      if (!(err instanceof DiscordError) || err.status !== 404) throw err;
      // message supprimé à la main : on en publie un nouveau
    }
  }
  const id = await send(channel, payload);
  await prisma.discordPost.upsert({ where: { key }, create: { key, channelId: channel, messageId: id }, update: { channelId: channel, messageId: id } });
}
