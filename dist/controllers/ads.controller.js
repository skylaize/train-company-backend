"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdStatus = getAdStatus;
exports.claimAdReward = claimAdReward;
const prisma_1 = require("../prisma");
const AD_REWARD = 20; // pièces versées par publicité regardée
const MAX_ADS_PER_DAY = 5; // au-delà, plus aucune récompense n'est versée ce jour-là
function todayKey() {
    return new Date().toISOString().slice(0, 10); // "AAAA-MM-JJ"
}
async function getAdStatus(req, res) {
    const company = await prisma_1.prisma.company.findUnique({ where: { ownerId: req.userId } });
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const record = await prisma_1.prisma.adWatch.findUnique({
        where: { companyId_date: { companyId: company.id, date: todayKey() } },
    });
    const watchedToday = record?.count ?? 0;
    return res.json({
        watchedToday,
        remaining: Math.max(0, MAX_ADS_PER_DAY - watchedToday),
        maxPerDay: MAX_ADS_PER_DAY,
        rewardPerAd: AD_REWARD,
    });
}
// Appelé uniquement depuis le callback "publicité terminée avec succès" du script publicitaire
// (jamais si la pub est fermée en avance, en erreur, ou non chargée — voir le SKILL front).
async function claimAdReward(req, res) {
    const company = await prisma_1.prisma.company.findUnique({ where: { ownerId: req.userId } });
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const date = todayKey();
    const result = await prisma_1.prisma.$transaction(async (tx) => {
        const existing = await tx.adWatch.findUnique({
            where: { companyId_date: { companyId: company.id, date } },
        });
        if ((existing?.count ?? 0) >= MAX_ADS_PER_DAY) {
            return null; // limite déjà atteinte, rien à faire
        }
        await tx.adWatch.upsert({
            where: { companyId_date: { companyId: company.id, date } },
            create: { companyId: company.id, date, count: 1 },
            update: { count: { increment: 1 } },
        });
        await tx.company.update({ where: { id: company.id }, data: { balance: { increment: AD_REWARD } } });
        await tx.transaction.create({
            data: {
                companyId: company.id,
                type: "PUBLICITE",
                amount: AD_REWARD,
                description: "Publicité regardée en entier",
            },
        });
        return true;
    });
    if (!result) {
        return res.status(409).json({ error: `Limite quotidienne atteinte (${MAX_ADS_PER_DAY} publicités par jour). Revenez demain.` });
    }
    return res.json({ success: true, reward: AD_REWARD });
}
