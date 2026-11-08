import { prisma } from "../prisma";

/* ============================================================
   2.6.1 : vote Top-Serveurs.

   Le joueur vote sur la fiche du jeu en saisissant son code de parrainage
   comme pseudo, puis réclame sa prime ici. Le serveur demande à Top-Serveurs
   si un vote existe sous ce pseudo (/votes/claim-username) : la réponse le
   marque comme utilisé chez eux, un même vote ne paie donc jamais deux fois.

   Côté jeu, une seule prime par jour (heure de Paris), même si Top-Serveurs
   accepte un vote toutes les deux heures : les votes suivants comptent pour
   le classement de la fiche, pas pour la trésorerie.

   Sans TOPSERVEURS_TOKEN, tout reste éteint et la carte ne s'affiche pas :
   on peut déployer avant que la fiche existe.
   ============================================================ */

const API = "https://api.top-serveurs.net/v1";

export const VOTE_BASE_REWARD = 60; // pi., premier jour
export const VOTE_STREAK_STEP = 10; // + par jour consécutif
export const VOTE_STREAK_CAP = 7; // au 7e jour d'affilée : 120 pi., puis ça plafonne

export function voteConfig() {
  const token = process.env.TOPSERVEURS_TOKEN?.trim() || null;
  const url = process.env.TOPSERVEURS_URL?.trim() || null; // page publique de la fiche
  return { token, url, enabled: !!token && !!url };
}

export function parisDay(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function previousDay(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/* Série en cours : elle ne survit que si le dernier vote récompensé date
   d'aujourd'hui ou d'hier. */
export function liveStreak(lastVoteDay: string | null, streak: number, today = parisDay()) {
  if (!lastVoteDay) return 0;
  return lastVoteDay === today || lastVoteDay === previousDay(today) ? streak : 0;
}

export function rewardFor(streak: number) {
  const days = Math.min(Math.max(streak, 1), VOTE_STREAK_CAP);
  return VOTE_BASE_REWARD + (days - 1) * VOTE_STREAK_STEP;
}

/* Prochain minuit à Paris, pour afficher « nouvelle prime dans … ». */
export function msUntilParisMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
  return 24 * 3600 * 1000 - elapsed;
}

export type ClaimState = "claimable" | "claimed" | "not_found";

/* Réponse de Top-Serveurs : claimed 1 = vote trouvé et désormais utilisé,
   2 = déjà utilisé, 0 ou 404 = aucun vote récent sous ce pseudo. */
export async function claimOnTopServeurs(token: string, playername: string): Promise<ClaimState> {
  const qs = new URLSearchParams({ server_token: token, playername });
  const res = await fetch(`${API}/votes/claim-username?${qs}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 404) return "not_found";
  const data = (await res.json().catch(() => null)) as { success?: boolean; claimed?: number | string; message?: string } | null;
  if (!res.ok || !data) throw new Error(`Top-Serveurs ${res.status}`);
  if (data.success === false && Number((data as { code?: number }).code) === 404) return "not_found";
  const claimed = Number(data.claimed);
  if (claimed === 1) return "claimable";
  if (claimed === 2) return "claimed";
  if (claimed === 0) return "not_found";
  throw new Error(`Top-Serveurs : réponse inattendue (${data.message ?? "?"})`);
}

/* Verse la prime du jour. Renvoie null si le jour était déjà payé (la clé
   composée de VoteReward tranche, même en cas de course). */
export async function grantVoteReward(companyId: string, lastVoteDay: string | null, streak: number) {
  const today = parisDay();
  const nextStreak = liveStreak(lastVoteDay, streak, today) + 1;
  const amount = rewardFor(nextStreak);

  try {
    await prisma.$transaction([
      prisma.voteReward.create({ data: { companyId, day: today, amount, streak: nextStreak } }),
      prisma.company.update({
        where: { id: companyId },
        data: { balance: { increment: amount }, voteStreak: nextStreak, lastVoteDay: today },
      }),
      prisma.transaction.create({
        data: {
          companyId,
          type: "VOTE",
          amount,
          description:
            nextStreak > 1
              ? `Vote Top-Serveurs — ${nextStreak} jours d'affilée`
              : "Vote Top-Serveurs — merci pour le coup de pouce",
        },
      }),
    ]);
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return null;
    throw e;
  }
  return { amount, streak: nextStreak, nextReward: rewardFor(nextStreak + 1) };
}

/* ============================================================
   Voteurs du mois.

   Chaque vote validé compte (un toutes les 2 h chez Top-Serveurs), pas
   seulement celui qui paie la prime du jour. Les trois premiers gagnent des
   pièces (VOTE_PRIZES), l'emblème « Tampon de contrôle » et le rôle Discord
   « Voteur du mois » pendant le mois suivant. Rien n'est versé tout seul : l'équipe vérifie le
   podium dans l'admin (multi-comptes) puis clique « Verser ».
   ============================================================ */

export const VOTE_WINNERS = 3;
// pièces versées au podium, dans l'ordre (pour comparer : voter chaque jour rapporte ~3 300 pi. par mois)
export const VOTE_PRIZES = [5000, 3000, 1500];
export const VOTE_EMBLEM = "tampon";

export const parisMonth = (d = new Date()) => parisDay(d).slice(0, 7);

export function previousMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export async function recordVote(companyId: string) {
  const month = parisMonth();
  const now = new Date();
  const row = (await prisma.voteMonth.upsert({
    where: { companyId_month: { companyId, month } },
    create: { companyId, month, votes: 1, lastAt: now },
    update: { votes: { increment: 1 }, lastAt: now },
  })) as { votes: number };
  topCache.delete(month);
  return row.votes;
}

export type VoterRow = { rank: number; companyId: string; name: string; liveryColor: string; emblem: string | null; votes: number };

// classement d'un mois gardé une minute, pour tous les joueurs à la fois
const topCache = new Map<string, { at: number; rows: VoterRow[] }>();
const TOP_TTL = 60_000;

export async function monthTop(month: string, n = 10, exclude: string[] = []): Promise<VoterRow[]> {
  const cacheable = exclude.length === 0 && n <= 10;
  const hit = cacheable ? topCache.get(month) : null;
  if (hit && Date.now() - hit.at < TOP_TTL) return hit.rows.slice(0, n);
  const rows = (await prisma.voteMonth.findMany({
    where: { month, votes: { gt: 0 }, ...(exclude.length ? { companyId: { notIn: exclude } } : {}) },
    orderBy: [{ votes: "desc" }, { lastAt: "asc" }],
    take: cacheable ? 10 : n,
    select: { companyId: true, votes: true },
  })) as { companyId: string; votes: number }[];
  const companies = (await prisma.company.findMany({
    where: { id: { in: rows.map((r) => r.companyId) } },
    select: { id: true, name: true, liveryColor: true, emblem: true },
  })) as { id: string; name: string; liveryColor: string; emblem: string | null }[];
  const byId = new Map(companies.map((c) => [c.id, c]));
  const out = rows
    .filter((r) => byId.has(r.companyId))
    .map((r, i) => {
      const c = byId.get(r.companyId)!;
      return { rank: i + 1, companyId: r.companyId, name: c.name, liveryColor: c.liveryColor, emblem: c.emblem, votes: r.votes };
    });
  if (cacheable) topCache.set(month, { at: Date.now(), rows: out });
  return out.slice(0, n);
}

/* Sa place du mois : deux petits comptages sur la table du mois. */
export async function myMonth(companyId: string, month = parisMonth()) {
  const me = (await prisma.voteMonth.findUnique({ where: { companyId_month: { companyId, month } }, select: { votes: true, lastAt: true } })) as { votes: number; lastAt: Date } | null;
  if (!me || me.votes === 0) return { votes: 0, rank: null as number | null };
  const ahead = await prisma.voteMonth.count({
    where: { month, OR: [{ votes: { gt: me.votes } }, { votes: me.votes, lastAt: { lt: me.lastAt } }] },
  });
  return { votes: me.votes, rank: ahead + 1 };
}

export async function isVoteWinner(companyId: string) {
  return Boolean(await prisma.voteWinner.findFirst({ where: { companyId }, select: { month: true } }));
}

/* Le rôle Discord se porte pendant le mois qui suit celui gagné. */
export async function voteRoleHolders(): Promise<Set<string>> {
  const rows = (await prisma.voteWinner.findMany({ where: { month: previousMonth(parisMonth()) }, select: { companyId: true } })) as { companyId: string }[];
  return new Set(rows.map((r) => r.companyId));
}

/* Fin du mois à Paris, pour « il reste 12 jours ». */
export function msUntilMonthEnd(now = new Date()) {
  const [y, m] = parisMonth(now).split("-").map(Number);
  // minuit à Paris le 1er du mois suivant : à 1 h près selon l'heure d'été, c'est un compte à rebours en jours
  const next = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 0, 0, 0) - 60 * 60_000;
  return Math.max(0, next - now.getTime());
}
