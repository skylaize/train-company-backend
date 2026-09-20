"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNetworkStats = getNetworkStats;
const prisma_1 = require("../prisma");
async function getNetworkStats(_req, res) {
    const [activeCompanies, trainsInService, goodTrips, totalIncidents, recentIncidents] = await Promise.all([
        prisma_1.prisma.company.count(),
        prisma_1.prisma.train.count({ where: { status: "EN_ROUTE" } }),
        prisma_1.prisma.transaction.count({ where: { type: "REVENU_LIGNE" } }),
        prisma_1.prisma.incident.count(),
        prisma_1.prisma.incident.count({ where: { createdAt: { gte: new Date(Date.now() - 10 * 60000) } } }),
    ]);
    const totalOps = goodTrips + totalIncidents;
    const punctuality = totalOps === 0 ? 100 : Math.round((goodTrips / totalOps) * 100);
    return res.json({
        activeCompanies,
        trainsInService,
        punctuality,
        activeIncidents: recentIncidents,
    });
}
