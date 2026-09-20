"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTodaySummary = getTodaySummary;
const prisma_1 = require("../prisma");
function startOfToday() {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
}
async function getTodaySummary(req, res) {
    const company = await prisma_1.prisma.company.findUnique({ where: { ownerId: req.userId } });
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const since = startOfToday();
    const [transactionsToday, incidentsToday] = await Promise.all([
        prisma_1.prisma.transaction.findMany({ where: { companyId: company.id, createdAt: { gte: since } } }),
        prisma_1.prisma.incident.count({ where: { train: { companyId: company.id }, createdAt: { gte: since } } }),
    ]);
    const income = transactionsToday.filter((t) => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
    const expenses = transactionsToday.filter((t) => t.amount < 0).reduce((sum, t) => sum + t.amount, 0);
    const lineTrips = transactionsToday.filter((t) => t.type === "REVENU_LIGNE").length;
    const freightDeliveries = transactionsToday.filter((t) => t.type === "FRET").length;
    return res.json({
        income,
        expenses,
        net: income + expenses,
        lineTrips,
        freightDeliveries,
        incidents: incidentsToday,
    });
}
