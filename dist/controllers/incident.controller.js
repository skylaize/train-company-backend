"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listMyIncidents = listMyIncidents;
const prisma_1 = require("../prisma");
async function listMyIncidents(req, res) {
    const company = await prisma_1.prisma.company.findUnique({ where: { ownerId: req.userId } });
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const incidents = await prisma_1.prisma.incident.findMany({
        where: { train: { companyId: company.id } },
        include: { train: true },
        orderBy: { createdAt: "desc" },
        take: 10,
    });
    return res.json(incidents);
}
