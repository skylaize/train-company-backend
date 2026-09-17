import { Response } from "express";
import bcrypt from "bcrypt";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

export async function changePassword(req: AuthRequest, res: Response) {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword et newPassword sont requis" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 6 caractères" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId as string } });
  if (!user) {
    return res.status(404).json({ error: "Utilisateur introuvable" });
  }

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) {
    return res.status(401).json({ error: "Mot de passe actuel incorrect" });
  }

  const hashed = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });

  return res.json({ success: true });
}

export async function deleteAccount(req: AuthRequest, res: Response) {
  const userId = req.userId as string;

  const company = await prisma.company.findUnique({ where: { ownerId: userId } });

  if (company) {
    const trains = await prisma.train.findMany({ where: { companyId: company.id }, select: { id: true } });
    const trainIds = trains.map((t) => t.id);

    // suppression en cascade manuelle, dans l'ordre qui respecte les contraintes de clé étrangère
    await prisma.$transaction([
      prisma.incident.deleteMany({ where: { trainId: { in: trainIds } } }),
      prisma.contract.deleteMany({ where: { companyId: company.id } }),
      prisma.transaction.deleteMany({ where: { companyId: company.id } }),
      prisma.dailyChallenge.deleteMany({ where: { companyId: company.id } }),
      prisma.staff.deleteMany({ where: { companyId: company.id } }),
      prisma.train.deleteMany({ where: { companyId: company.id } }),
      prisma.line.deleteMany({ where: { companyId: company.id } }),
      prisma.company.delete({ where: { id: company.id } }),
    ]);
  }

  await prisma.user.delete({ where: { id: userId } });

  return res.json({ success: true });
}
