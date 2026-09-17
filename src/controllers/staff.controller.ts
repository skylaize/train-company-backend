import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

export const STAFF_ROLES: Record<string, { label: string; salaryPerTick: number; effect: string; premium: boolean }> = {
  MECANICIEN: {
    label: "Mécanicien",
    salaryPerTick: 3,
    effect: "Réduit l'usure accumulée par vos rames en service (davantage encore en Premium)",
    premium: false,
  },
  CHEF_DEPOT: {
    label: "Chef de dépôt",
    salaryPerTick: 4,
    effect: "Réduit le coût des réparations (encore plus en Premium)",
    premium: false,
  },
  DIRECTEUR_COMMERCIAL: {
    label: "Directeur commercial",
    salaryPerTick: 6,
    effect: "Augmente de 15% tous vos revenus (voyageurs et fret) — poste Premium",
    premium: true,
  },
};

async function getOwnedCompanyOrFail(userId: string) {
  return prisma.company.findUnique({ where: { ownerId: userId } });
}

export async function listMyStaff(req: AuthRequest, res: Response) {
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const staff = await prisma.staff.findMany({ where: { companyId: company.id } });
  return res.json(staff);
}

export async function hireStaff(req: AuthRequest, res: Response) {
  const { role } = req.body;

  if (!role || !STAFF_ROLES[role]) {
    return res.status(400).json({ error: "Rôle invalide" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  if (STAFF_ROLES[role].premium && !company.isPremium) {
    return res.status(403).json({ error: "Ce poste est réservé aux compagnies Premium" });
  }

  const existing = await prisma.staff.findUnique({ where: { companyId_role: { companyId: company.id, role } } });
  if (existing) {
    return res.status(409).json({ error: "Ce poste est déjà pourvu" });
  }

  const staff = await prisma.staff.create({
    data: { companyId: company.id, role, salaryPerTick: STAFF_ROLES[role].salaryPerTick },
  });

  return res.status(201).json(staff);
}

export async function fireStaff(req: AuthRequest, res: Response) {
  const { staffId } = req.body;

  if (!staffId) {
    return res.status(400).json({ error: "staffId est requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const staff = await prisma.staff.findFirst({ where: { id: staffId, companyId: company.id } });
  if (!staff) {
    return res.status(404).json({ error: "Employé introuvable" });
  }

  await prisma.staff.delete({ where: { id: staffId } });
  return res.json({ success: true });
}
