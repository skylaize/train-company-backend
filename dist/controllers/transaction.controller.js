"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listMyTransactions = listMyTransactions;
const prisma_1 = require("../prisma");
async function listMyTransactions(req, res) {
    const company = await prisma_1.prisma.company.findUnique({ where: { ownerId: req.userId } });
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const transactions = await prisma_1.prisma.transaction.findMany({
        where: { companyId: company.id },
        orderBy: { createdAt: "desc" },
        take: 30,
    });
    return res.json(transactions);
}
