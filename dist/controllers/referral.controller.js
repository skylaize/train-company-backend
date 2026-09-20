"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMyReferral = getMyReferral;
const prisma_1 = require("../prisma");
const referral_milestone_service_1 = require("../services/referral-milestone.service");
async function getMyReferral(req, res) {
    const company = await prisma_1.prisma.company.findUnique({
        where: { ownerId: req.userId },
        select: { id: true, referralCode: true, referredById: true, referralMilestone: true, title: true },
    });
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const [referrals, qualifiedMap] = await Promise.all([
        prisma_1.prisma.company.findMany({
            where: { referredById: company.id },
            select: { name: true, referralRewardGranted: true },
        }),
        (0, referral_milestone_service_1.countQualifiedReferrals)(),
    ]);
    const list = referrals;
    const qualified = qualifiedMap.get(company.id) ?? 0;
    // prochain palier restant à atteindre, pour afficher une cible concrète
    const next = referral_milestone_service_1.REFERRAL_MILESTONES.find((m) => company.referralMilestone < m.count) ?? null;
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
        milestones: referral_milestone_service_1.REFERRAL_MILESTONES.map((m) => ({
            count: m.count,
            label: m.label,
            unlocked: company.referralMilestone >= m.count,
        })),
        nextMilestone: next ? { count: next.count, label: next.label, remaining: Math.max(0, next.count - qualified) } : null,
    });
}
