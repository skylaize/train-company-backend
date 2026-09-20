import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { buildLeaderRows } from "../services/leaderboard.service";

export const STAFF_ROLES: Record<string, { label: string; salaryPerTick: number; effect: string; minGradeId: number }> = {
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

  if (STAFF_ROLES[role].minGradeId > 0) {
    const rows = await buildLeaderRows();
    const gradeId = rows.find((r) => r.id === company.id)?.gradeId ?? 0;
    if (gradeId < STAFF_ROLES[role].minGradeId) {
      return res.status(403).json({ error: "Ce poste demande le grade « Chef de réseau »" });
    }
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
