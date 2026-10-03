import { Response } from "express";
import jwt from "jsonwebtoken";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

/* ============================================================
   Vidéos récompensées (1.7, Google AdSense — Ad Placement API).

   Le joueur choisit de regarder une publicité contre des pièces. AdSense ne
   confirme pas côté serveur qu'une vidéo a été vue : on encadre donc le
   versement. /ads/start délivre un jeton signé ; /ads/claim ne paie qu'avec ce
   jeton, une seule fois, et pas avant le temps minimal d'une vidéo. Tricher
   reste possible en théorie, mais le gain est plafonné à cinq vidéos par jour.
   ============================================================ */

const MAX_ADS_PER_DAY = 5; // au-delà, plus aucune récompense n'est versée ce jour-là
const MIN_WATCH_MS = 8_000; // une vidéo récompensée dure au moins une dizaine de secondes
const TOKEN_TTL_S = 10 * 60;
// la récompense suit la taille de la compagnie : 15 % d'une heure de recettes, entre 20 et 400 pi.
const REWARD_SHARE = 0.15;
const REWARD_MIN = 20;
const REWARD_MAX = 400;

// secret distinct de celui des sessions : un jeton de pub ne doit jamais servir à se connecter
const adSecret = () => `${process.env.JWT_SECRET}:ads`;
const used = new Map<string, number>(); // jetons déjà encaissés (jti → expiration)

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "AAAA-MM-JJ"
}

async function rewardFor(companyId: string) {
  const agg = (await prisma.transaction.aggregate({
    where: { companyId, type: "REVENU_LIGNE", createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
    _sum: { amount: true },
  })) as { _sum: { amount: number | null } };
  const hourly = (agg._sum.amount ?? 0) / 24;
  return Math.max(REWARD_MIN, Math.min(REWARD_MAX, Math.round((hourly * REWARD_SHARE) / 5) * 5));
}

async function companyOf(req: AuthRequest) {
  return prisma.company.findUnique({ where: { ownerId: req.userId as string } }) as Promise<{ id: string; isPremium: boolean } | null>;
}

export async function getAdStatus(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const record = await prisma.adWatch.findUnique({ where: { companyId_date: { companyId: company.id, date: todayKey() } } });
  const watchedToday = record?.count ?? 0;
  return res.json({
    watchedToday,
    remaining: Math.max(0, MAX_ADS_PER_DAY - watchedToday),
    maxPerDay: MAX_ADS_PER_DAY,
    rewardPerAd: await rewardFor(company.id),
    isPremium: company.isPremium,
  });
}

/* Début d'une vidéo : un jeton signé, valable dix minutes, à rendre à la fin. */
export async function startAd(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const record = await prisma.adWatch.findUnique({ where: { companyId_date: { companyId: company.id, date: todayKey() } } });
  if ((record?.count ?? 0) >= MAX_ADS_PER_DAY) {
    return res.status(409).json({ error: `Limite quotidienne atteinte (${MAX_ADS_PER_DAY} publicités par jour). Revenez demain.` });
  }
  const jti = `${company.id}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const token = jwt.sign({ cid: company.id, kind: "ad", jti }, adSecret(), { expiresIn: TOKEN_TTL_S });
  return res.json({ token });
}

// Appelé uniquement depuis le callback adViewed() d'AdSense : jamais si la vidéo
// a été fermée en avance, n'a pas chargé, ou a échoué.
export async function claimAdReward(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  let payload: { cid?: string; kind?: string; jti?: string; iat?: number };
  try {
    payload = jwt.verify(String(req.body?.token ?? ""), adSecret()) as typeof payload;
  } catch {
    return res.status(400).json({ error: "Publicité expirée, relancez-en une" });
  }
  if (payload.kind !== "ad" || payload.cid !== company.id || !payload.jti || !payload.iat) {
    return res.status(400).json({ error: "Publicité invalide" });
  }
  if (Date.now() - payload.iat * 1000 < MIN_WATCH_MS) return res.status(400).json({ error: "La publicité n'a pas été vue en entier" });
  const now = Date.now();
  for (const [k, exp] of used) if (exp < now) used.delete(k);
  if (used.has(payload.jti)) return res.status(409).json({ error: "Récompense déjà versée pour cette publicité" });
  used.set(payload.jti, now + TOKEN_TTL_S * 1000);

  const reward = await rewardFor(company.id);
  const date = todayKey();
  const result = await prisma.$transaction(async (tx: any) => {
    const existing = await tx.adWatch.findUnique({ where: { companyId_date: { companyId: company.id, date } } });
    if ((existing?.count ?? 0) >= MAX_ADS_PER_DAY) return null;
    await tx.adWatch.upsert({
      where: { companyId_date: { companyId: company.id, date } },
      create: { companyId: company.id, date, count: 1 },
      update: { count: { increment: 1 } },
    });
    await tx.company.update({ where: { id: company.id }, data: { balance: { increment: reward } } });
    await tx.transaction.create({ data: { companyId: company.id, type: "PUBLICITE", amount: reward, description: "Publicité regardée en entier" } });
    return true;
  });

  if (!result) {
    return res.status(409).json({ error: `Limite quotidienne atteinte (${MAX_ADS_PER_DAY} publicités par jour). Revenez demain.` });
  }
  return res.json({ success: true, reward });
}
