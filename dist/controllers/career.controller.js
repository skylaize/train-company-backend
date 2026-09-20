"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMyCareer = getMyCareer;
const prisma_1 = require("../prisma");
const career_service_1 = require("../services/career.service");
async function getMyCareer(req, res) {
    const company = await prisma_1.prisma.company.findUnique({ where: { ownerId: req.userId } });
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const career = await (0, career_service_1.computeCareerStatus)(company.id);
    return res.json(career);
}
