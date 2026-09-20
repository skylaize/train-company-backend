import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import {
  REFERRAL_MILESTONES,
  countQualifiedReferrals,
} from "../services/referral-milestone.service";

export async function getMyReferral(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true, referralCode: true, referredById: true, referralMilestone: true, title: true },
  });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const [referrals, qualifiedMap] = await Promise.all([
    prisma.company.findMany({
      where: { referredById: company.id },
      select: { name: true, referralRewardGranted: true },
    }),
    countQualifiedReferrals(),
  ]);

  const list = referrals as Array<{ name: string; referralRewardGranted: boolean }>;
  const qualified = qualifiedMap.get(company.id) ?? 0;

  // prochain palier restant à atteindre, pour afficher une cible concrète
  const next = REFERRAL_MILESTONES.find((m) => company.referralMilestone < m.count) ?? null;

  return res.json({
    code: company.referralCode,
    wasReferred: !!company.referredById,
    title: company.title,
    totalReferred: list.length,
    rewardsGranted: list.filter((r) => r.referralRewardGranted).length,
    pendingRewards: list.filter((r) => !r.referralRewardGranted).length,
    referrals: list.map((r) => ({ name: r.name, rewarded: r.referralRewardGranted })),

    // progression vers les paliers
    qualified,
    milestoneReached: company.referralMilestone,
    milestones: REFERRAL_MILESTONES.map((m) => ({
      count: m.count,
      label: m.label,
      unlocked: company.referralMilestone >= m.count,
    })),
    nextMilestone: next ? { count: next.count, label: next.label, remaining: Math.max(0, next.count - qualified) } : null,
  });
}
