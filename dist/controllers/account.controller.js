"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.changePassword = changePassword;
exports.deleteAccount = deleteAccount;
const bcrypt_1 = __importDefault(require("bcrypt"));
const prisma_1 = require("../prisma");
async function changePassword(req, res) {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: "currentPassword et newPassword sont requis" });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 6 caractères" });
    }
    const user = await prisma_1.prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) {
        return res.status(404).json({ error: "Utilisateur introuvable" });
    }
    const valid = await bcrypt_1.default.compare(currentPassword, user.password);
    if (!valid) {
        return res.status(401).json({ error: "Mot de passe actuel incorrect" });
    }
    const hashed = await bcrypt_1.default.hash(newPassword, 10);
    await prisma_1.prisma.user.update({ where: { id: user.id }, data: { password: hashed } });
    return res.json({ success: true });
}
async function deleteAccount(req, res) {
    const userId = req.userId;
    const company = await prisma_1.prisma.company.findUnique({ where: { ownerId: userId } });
    if (company) {
        const trains = await prisma_1.prisma.train.findMany({ where: { companyId: company.id }, select: { id: true } });
        const trainIds = trains.map((t) => t.id);
        // suppression en cascade manuelle, dans l'ordre qui respecte les contraintes de clé étrangère
        await prisma_1.prisma.$transaction([
            prisma_1.prisma.incident.deleteMany({ where: { trainId: { in: trainIds } } }),
            prisma_1.prisma.contract.deleteMany({ where: { companyId: company.id } }),
            prisma_1.prisma.transaction.deleteMany({ where: { companyId: company.id } }),
            prisma_1.prisma.dailyChallenge.deleteMany({ where: { companyId: company.id } }),
            prisma_1.prisma.staff.deleteMany({ where: { companyId: company.id } }),
            prisma_1.prisma.achievementUnlock.deleteMany({ where: { companyId: company.id } }),
            prisma_1.prisma.adWatch.deleteMany({ where: { companyId: company.id } }),
            // si cette compagnie a parrainé d'autres joueurs, on détache la référence plutôt que
            // de les impacter (ils gardent leur historique, juste sans parrain associé)
            prisma_1.prisma.company.updateMany({ where: { referredById: company.id }, data: { referredById: null } }),
            prisma_1.prisma.train.deleteMany({ where: { companyId: company.id } }),
            prisma_1.prisma.line.deleteMany({ where: { companyId: company.id } }),
            prisma_1.prisma.company.delete({ where: { id: company.id } }),
        ]);
    }
    await prisma_1.prisma.user.delete({ where: { id: userId } });
    return res.json({ success: true });
}
