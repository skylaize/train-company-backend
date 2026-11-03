import { prisma } from "../prisma";
import { botEnabled, BRAND_COLOR, DiscordError, rest } from "./discord.service";

/* ============================================================
   Notifications du jeu en message privé Discord (2.5).

   Chaque notification envoyée au navigateur (sendToCompany) part aussi en
   message privé aux joueurs qui ont lié leur compte et choisi la catégorie
   avec /notifs. Rien n'est activé par défaut.

   Garde-fous : une même étiquette au plus une fois par 3 minutes, et au
   plus 15 messages par heure et par joueur. Un joueur qui a fermé ses
   messages privés n'est pas relancé pendant 6 heures.
   ============================================================ */

export const DM_CATEGORIES = {
  flotte: { label: "Flotte", emoji: "🚂", detail: "pannes, incidents, chantiers, personnel, énergie, LGV, épaves" },
  fret: { label: "Fret", emoji: "📦", detail: "tournées livrées, conteneurs scellés" },
  competition: { label: "Compétition", emoji: "🏆", detail: "saison, alliance, régions, concurrence, appels d'offres" },
  finances: { label: "Finances", emoji: "💰", detail: "banque, bourse, alertes, rapports, décisions, gares, taxe carbone" },
  cadeaux: { label: "Cadeaux", emoji: "🎁", detail: "cadeaux reçus, Premium d'essai, boost" },
  autres: { label: "Autres", emoji: "🔔", detail: "événements du jeu et tout le reste" },
} as const;
export type DmCategory = keyof typeof DM_CATEGORIES;
export const DM_ALL = Object.keys(DM_CATEGORIES) as DmCategory[];

const TAG_CATEGORY: Record<string, DmCategory> = {
  incident: "flotte", energie: "flotte", chantier: "flotte", personnel: "flotte", lgv: "flotte",
  fret: "fret",
  saison: "competition", regions: "competition", alliance: "competition", compagnonnage: "competition", concurrence: "competition", appels: "competition",
  banque: "finances", bourse: "finances", alerte: "finances", ordre: "finances", rapport: "finances", bilan: "finances", decision: "finances", gares: "finances", carbone: "finances",
  cadeau: "cadeaux", "premium-essai": "cadeaux", boost: "cadeaux",
  epave: "flotte",
  gare: "competition", // 2.6 : gares surveillées (« gare-<nom> »)
};
// certaines étiquettes portent un suffixe (« alerte-CEREALES », « ordre-ACIER », « epave-<id> ») : on regarde aussi le début
export const categoryOfTag = (tag: string | undefined): DmCategory => {
  const t = tag ?? "";
  return TAG_CATEGORY[t] ?? TAG_CATEGORY[t.split("-")[0]] ?? "autres";
};

export function parseDmSetting(raw: string | null | undefined): Set<DmCategory> {
  return new Set(String(raw ?? "").split(",").filter((c): c is DmCategory => c in DM_CATEGORIES));
}

const SITE_URL = (process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
const TAG_COOLDOWN_MS = 3 * 60_000;
const HOURLY_MAX = 15;
const BLOCKED_MS = 6 * 3_600_000;

const lastByTag = new Map<string, number>(); // `${discordId}|${tag}` → date
const sentThisHour = new Map<string, number[]>(); // discordId → dates
const blockedUntil = new Map<string, number>(); // discordId → date
const dmChannel = new Map<string, string>(); // discordId → salon privé

function allowed(discordId: string, tag: string) {
  const now = Date.now();
  if ((blockedUntil.get(discordId) ?? 0) > now) return false;
  const key = `${discordId}|${tag}`;
  if (now - (lastByTag.get(key) ?? 0) < TAG_COOLDOWN_MS) return false;
  const recent = (sentThisHour.get(discordId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= HOURLY_MAX) return false;
  lastByTag.set(key, now);
  sentThisHour.set(discordId, [...recent, now]);
  return true;
}

export async function sendDm(discordId: string, payload: { embeds: unknown[] }) {
  let channel = dmChannel.get(discordId);
  if (!channel) {
    const c = await rest<{ id: string }>("POST", "/users/@me/channels", { body: { recipient_id: discordId } });
    channel = c!.id;
    dmChannel.set(discordId, channel);
  }
  try {
    await rest("POST", `/channels/${channel}/messages`, { body: { ...payload, allowed_mentions: { parse: [] } } });
  } catch (err) {
    // 50007 : le joueur n'accepte pas les messages privés du serveur
    if (err instanceof DiscordError && (err.status === 403 || /50007/.test(err.message))) {
      blockedUntil.set(discordId, Date.now() + BLOCKED_MS);
      return;
    }
    throw err;
  }
}

/* Appelé par sendToCompany pour chaque notification du jeu. Ne lève jamais. */
export async function notifyCompanyByDm(companyId: string, message: { title: string; body: string; url?: string; tag?: string }) {
  if (!botEnabled() || message.tag === "test") return;
  try {
    const owner = await prisma.company.findUnique({ where: { id: companyId }, select: { owner: { select: { discordId: true, discordDm: true } } } });
    const discordId = owner?.owner?.discordId;
    if (!discordId) return;
    const category = categoryOfTag(message.tag);
    if (!parseDmSetting(owner.owner.discordDm).has(category)) return;
    if (!allowed(discordId, message.tag ?? category)) return;
    const meta = DM_CATEGORIES[category];
    await sendDm(discordId, {
      embeds: [
        {
          title: `${meta.emoji} ${message.title}`,
          description: message.body,
          url: SITE_URL ? `${SITE_URL}${message.url && message.url.startsWith("/") ? message.url : "/dashboard"}` : undefined,
          color: BRAND_COLOR,
          footer: { text: `${meta.label} · réglages avec /notifs sur le serveur Réseau` },
        },
      ],
    });
  } catch (err) {
    console.error("[discord] message privé :", (err as Error).message);
  }
}
