"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeReputation = computeReputation;
const prisma_1 = require("../prisma");
// Réputation = pourcentage de trajets voyageurs réussis sans incident (retard/panne),
// sur l'ensemble des trajets + incidents enregistrés. 100 par défaut si aucun historique.
async function computeReputation(companyId) {
    const [goodTrips, incidents] = await Promise.all([
        prisma_1.prisma.transaction.count({ where: { companyId, type: "REVENU_LIGNE" } }),
        prisma_1.prisma.incident.count({ where: { train: { companyId } } }),
    ]);
    const total = goodTrips + incidents;
    if (total === 0)
        return 100;
    return Math.round((goodTrips / total) * 100);
}
