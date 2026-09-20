"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rankFromContext = rankFromContext;
exports.computeCareerStatus = computeCareerStatus;
const prisma_1 = require("../prisma");
const reputation_service_1 = require("./reputation.service");
// Chaque grade nécessite de remplir TOUTES ses conditions. Les seuils sont volontairement
// croissants d'un grade à l'autre, pour qu'atteindre un grade implique déjà les précédents.
const RANK_DEFINITIONS = [
    {
        name: "Apprenti exploitant",
        requirements: [],
    },
    {
        name: "Gestionnaire confirmé",
        requirements: [
            { label: "Posséder au moins 3 rames", check: (ctx) => ctx.trainCount >= 3 },
            { label: "Avoir tracé au moins 2 lignes", check: (ctx) => ctx.lineCount >= 2 },
            { label: "Avoir généré 1 000 pi. de recettes cumulées", check: (ctx) => ctx.totalRevenue >= 1000 },
        ],
    },
    {
        name: "Chef de réseau",
        requirements: [
            { label: "Employer au moins 1 membre du personnel", check: (ctx) => ctx.staffCount >= 1 },
            { label: "Avoir livré 5 contrats de fret", check: (ctx) => ctx.freightDelivered >= 5 },
            { label: "Avoir généré 3 000 pi. de recettes cumulées", check: (ctx) => ctx.totalRevenue >= 3000 },
        ],
    },
    {
        name: "Baron du rail",
        requirements: [
            { label: "Posséder au moins 5 rames", check: (ctx) => ctx.trainCount >= 5 },
            { label: "Réputation d'au moins 80%", check: (ctx) => ctx.reputation >= 80 },
            { label: "Avoir généré 8 000 pi. de recettes cumulées", check: (ctx) => ctx.totalRevenue >= 8000 },
        ],
    },
    {
        name: "Magnat ferroviaire",
        requirements: [
            { label: "Employer au moins 2 membres du personnel", check: (ctx) => ctx.staffCount >= 2 },
            { label: "Dépôt porté à 6 places ou plus", check: (ctx) => ctx.maxTrains >= 6 },
            { label: "Avoir généré 20 000 pi. de recettes cumulées", check: (ctx) => ctx.totalRevenue >= 20000 },
        ],
    },
];
/* Grade atteint pour un contexte donné, sans aucune requête : le classement
   s'en sert pour étiqueter toutes les compagnies d'un coup. */
function rankFromContext(ctx) {
    let current = 0;
    RANK_DEFINITIONS.forEach((def, id) => {
        if (def.requirements.every((r) => r.check(ctx)))
            current = id;
    });
    return { id: current, name: RANK_DEFINITIONS[current].name };
}
async function computeCareerStatus(companyId) {
    const [trainCount, lines, staffCount, freightDelivered, revenueAgg, reputation, company] = await Promise.all([
        prisma_1.prisma.train.count({ where: { companyId } }),
        prisma_1.prisma.line.count({ where: { companyId } }),
        prisma_1.prisma.staff.count({ where: { companyId } }),
        prisma_1.prisma.contract.count({ where: { companyId, status: "LIVREE" } }),
        prisma_1.prisma.transaction.aggregate({
            where: { companyId, amount: { gt: 0 }, type: { not: "FONDATION" } },
            _sum: { amount: true },
        }),
        (0, reputation_service_1.computeReputation)(companyId),
        prisma_1.prisma.company.findUnique({ where: { id: companyId }, select: { maxTrains: true } }),
    ]);
    const ctx = {
        trainCount,
        lineCount: lines,
        staffCount,
        freightDelivered,
        totalRevenue: revenueAgg._sum.amount ?? 0,
        reputation,
        maxTrains: company?.maxTrains ?? 2,
    };
    const ranks = RANK_DEFINITIONS.map((def, id) => ({
        id,
        name: def.name,
        requirements: def.requirements.map((r) => ({ label: r.label, met: r.check(ctx) })),
        achieved: def.requirements.every((r) => r.check(ctx)),
    }));
    // une seule source de vérité : la même fonction que celle utilisée par le classement
    const currentRankId = rankFromContext(ctx).id;
    return {
        currentRank: ranks[currentRankId],
        nextRank: ranks[currentRankId + 1] ?? null,
        ranks,
    };
}
