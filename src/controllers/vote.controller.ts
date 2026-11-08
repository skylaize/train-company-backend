import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import {
  VOTE_STREAK_CAP,
  claimOnTopServeurs,
  grantVoteReward,
  liveStreak,
  msUntilParisMidnight,
  parisDay,
  rewardFor,
  voteConfig,
  recordVote,
  monthTop,
  myMonth,
  parisMonth,
  msUntilMonthEnd,
  VOTE_WINNERS,
  VOTE_PRIZES,
} from "../services/vote.service";

const SELECT = { id: true, referralCode: true, voteStreak: true, lastVoteDay: true } as const;

/* Un appel à Top-Serveurs par compagnie toutes les 20 s au plus : un joueur
   qui tapote « J'ai voté » en attendant que son vote remonte ne doit ni
   charger la petite machine ni se faire couper l'API. */
const COOLDOWN_MS = 20_000;
const lastTry = new Map<string, number>();
const busy = new Set<string>();

export async function getMyVote(req: AuthRequest, res: Response) {
  const cfg = voteConfig();
  if (!cfg.enabled) return res.json({ enabled: false });

  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: SELECT });
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const today = parisDay();
  const streak = liveStreak(company.lastVoteDay, company.voteStreak, today);
  const claimedToday = company.lastVoteDay === today;

  return res.json({
    enabled: true,
    url: cfg.url,
    pseudo: company.referralCode,
    claimedToday,
    streak,
    streakCap: VOTE_STREAK_CAP,
    // prochain vote récompensé (aujourd'hui, ou demain si c'est déjà fait) : la série +1
    nextReward: rewardFor(streak + 1),
    resetInMs: msUntilParisMidnight(),
    // voteurs du mois : le podium, sa place, le temps qui reste
    month: await monthSummary(company.id),
  });
}

async function monthSummary(companyId: string) {
  const month = parisMonth();
  const [top, me] = await Promise.all([monthTop(month, VOTE_WINNERS), myMonth(companyId, month)]);
  return { month, winners: VOTE_WINNERS, prizes: VOTE_PRIZES, top: top.map((r) => ({ ...r, me: r.companyId === companyId })), votes: me.votes, rank: me.rank, endsInMs: msUntilMonthEnd() };
}

export async function claimVote(req: AuthRequest, res: Response) {
  const cfg = voteConfig();
  if (!cfg.enabled || !cfg.token) return res.status(404).json({ error: "Le vote n'est pas encore ouvert" });

  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: SELECT });
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  // prime du jour déjà reçue : le vote est quand même vérifié, il compte pour les voteurs du mois
  const paidToday = company.lastVoteDay === parisDay();

  const now = Date.now();
  const wait = (lastTry.get(company.id) ?? 0) + COOLDOWN_MS - now;
  if (busy.has(company.id) || wait > 0) {
    return res.status(429).json({ error: `Patientez ${Math.max(1, Math.ceil(wait / 1000))} s avant de réessayer`, retryInMs: Math.max(wait, 1000) });
  }
  lastTry.set(company.id, now);
  busy.add(company.id);

  try {
    let state;
    try {
      state = await claimOnTopServeurs(cfg.token, company.referralCode);
    } catch (e) {
      console.error("[vote] Top-Serveurs injoignable :", (e as Error).message);
      return res.status(503).json({ error: "Top-Serveurs ne répond pas, réessayez dans une minute" });
    }

    if (state === "not_found") {
      return res.status(404).json({
        error: `Aucun vote trouvé sous le pseudo ${company.referralCode}. S'il vient d'être fait, attendez une minute et réessayez.`,
      });
    }
    if (state === "claimed") {
      return res.status(409).json({ error: "Ce vote a déjà été compté. Un nouveau vote est possible toutes les 2 h sur Top-Serveurs." });
    }

    // le vote est consommé chez Top-Serveurs : il compte pour le mois, prime ou pas
    const monthVotes = await recordVote(company.id);
    const granted = paidToday ? null : await grantVoteReward(company.id, company.lastVoteDay, company.voteStreak);
    return res.json({ ok: true, amount: granted?.amount ?? 0, streak: granted?.streak ?? null, nextReward: granted?.nextReward ?? null, monthVotes, month: await monthSummary(company.id) });
  } finally {
    busy.delete(company.id);
  }
}
