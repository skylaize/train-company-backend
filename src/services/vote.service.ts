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
