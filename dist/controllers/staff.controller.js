"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STAFF_ROLES = void 0;
exports.listMyStaff = listMyStaff;
exports.hireStaff = hireStaff;
exports.fireStaff = fireStaff;
const prisma_1 = require("../prisma");
const leaderboard_service_1 = require("../services/leaderboard.service");
exports.STAFF_ROLES = {
    MECANICIEN: {
        label: "Mécanicien",
        salaryPerTick: 3,
        effect: "Réduit de moitié l'usure accumulée par vos rames en service",
        minGradeId: 0,
    },
    CHEF_DEPOT: {
        label: "Chef de dépôt",
        salaryPerTick: 4,
        effect: "Réduit de moitié le coût des réparations",
        minGradeId: 0,
    },
    DIRECTEUR_COMMERCIAL: {
        label: "Directeur commercial",
        salaryPerTick: 6,
        effect: "Augmente de 15 % tous vos revenus — demande le grade « Chef de réseau »",
        minGradeId: 2,
    },
};
async function getOwnedCompanyOrFail(userId) {
    return prisma_1.prisma.company.findUnique({ where: { ownerId: userId } });
}
async function listMyStaff(req, res) {
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const staff = await prisma_1.prisma.staff.findMany({ where: { companyId: company.id } });
    return res.json(staff);
}
async function hireStaff(req, res) {
    const { role } = req.body;
    if (!role || !exports.STAFF_ROLES[role]) {
        return res.status(400).json({ error: "Rôle invalide" });
    }
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    if (exports.STAFF_ROLES[role].minGradeId > 0) {
        const rows = await (0, leaderboard_service_1.buildLeaderRows)();
        const gradeId = rows.find((r) => r.id === company.id)?.gradeId ?? 0;
        if (gradeId < exports.STAFF_ROLES[role].minGradeId) {
            return res.status(403).json({ error: "Ce poste demande le grade « Chef de réseau »" });
        }
    }
    const existing = await prisma_1.prisma.staff.findUnique({ where: { companyId_role: { companyId: company.id, role } } });
    if (existing) {
        return res.status(409).json({ error: "Ce poste est déjà pourvu" });
    }
    const staff = await prisma_1.prisma.staff.create({
        data: { companyId: company.id, role, salaryPerTick: exports.STAFF_ROLES[role].salaryPerTick },
    });
    return res.status(201).json(staff);
}
async function fireStaff(req, res) {
    const { staffId } = req.body;
    if (!staffId) {
        return res.status(400).json({ error: "staffId est requis" });
    }
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const staff = await prisma_1.prisma.staff.findFirst({ where: { id: staffId, companyId: company.id } });
    if (!staff) {
        return res.status(404).json({ error: "Employé introuvable" });
    }
    await prisma_1.prisma.staff.delete({ where: { id: staffId } });
    return res.json({ success: true });
}
