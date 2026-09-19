import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

export async function getMyReferral(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const referrals = await prisma.company.findMany({
    where: { referredById: company.id },
    select: { name: true, referralRewardGranted: true },
  });

  return res.json({
    code: company.referralCode,
    wasReferred: !!company.referredById,
    totalReferred: referrals.length,
    rewardsGranted: referrals.filter((r) => r.referralRewardGranted).length,
    pendingRewards: referrals.filter((r) => !r.referralRewardGranted).length,
    referrals: referrals.map((r) => ({ name: r.name, rewarded: r.referralRewardGranted })),
  });
}
