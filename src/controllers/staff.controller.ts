import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { buildLeaderRows } from "../services/leaderboard.service";
import {
  ROLES,
  salaryFor,
  levelFromXp,
  LEVEL_THRESHOLDS,
  MAX_LEVEL,
  randomStaffName,
  effectsFor,
  mechanicCoverage,
  chefCoverage,
  TICKS_PER_HOUR,
  coverageAllocation,
  estimatedSavingsPerHour,
} from "../services/staff.service";

async function getOwnedCompanyOrFail(userId: string) {
  return prisma.company.findUnique({ where: { ownerId: userId } });
}

type StaffRow = {
  id: string;
  role: string;
  name: string;
  level: number;
  xp: number;
  raiseRequested: boolean;
  salaryPerTick: number;
  hiredAt: Date;
  companyId: string;
};

/* Liste brute, au format historique (un tableau d'employés). Gardée telle
   quelle : l'ancienne interface la lit au chargement du tableau de bord, et la
   transformer ferait planter ce chargement pendant la fenêtre où le serveur est
   déjà à jour mais pas encore le site. Les nouveaux champs s'y ajoutent sans
   rien retirer. */
export async function listMyStaff(req: AuthRequest, res: Response) {
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }
  const staff = await prisma.staff.findMany({ where: { companyId: company.id }, orderBy: { hiredAt: "asc" } });
  return res.json(staff);
}

/* Vue du personnel : chaque employé, et pour chaque poste la couverture de la
   flotte. C'est ce second chiffre qui dit au joueur s'il doit embaucher : « 8
   rames couvertes sur 14 » se lit sans calcul. */
export async function getStaffOverview(req: AuthRequest, res: Response) {
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const [staff, trainCount, revenue24h] = await Promise.all([
    prisma.staff.findMany({ where: { companyId: company.id }, orderBy: { hiredAt: "asc" } }),
    prisma.train.count({ where: { companyId: company.id } }),
    prisma.transaction.aggregate({
      where: {
        companyId: company.id,
        type: { in: ["REVENU_LIGNE", "FRET"] },
        amount: { gt: 0 },
        createdAt: { gte: new Date(Date.now() - 24 * 3600_000) },
      },
      _sum: { amount: true },
    }),
  ]);
  const rows = staff as StaffRow[];
  const effects = effectsFor(rows, trainCount);
  const allocation = coverageAllocation(rows, trainCount);
  const revenuePerHour = ((revenue24h as { _sum: { amount: number | null } })._sum.amount ?? 0) / 24;

  const members = rows.map((s) => {
    const nextLevel = s.level < MAX_LEVEL ? s.level + 1 : null;
    const nextThreshold = nextLevel ? LEVEL_THRESHOLDS[nextLevel - 1] : null;
    return {
      id: s.id,
      role: s.role,
      roleLabel: ROLES[s.role]?.label ?? s.role,
      name: s.name || "Employé",
      level: s.level,
      xp: s.xp,
      // progression vers le niveau suivant, pour la barre
      xpForNext: nextThreshold,
      hoursToNext: nextThreshold ? Math.max(0, Math.ceil((nextThreshold - s.xp) / TICKS_PER_HOUR)) : null,
      raiseRequested: s.raiseRequested,
      salaryPerHour: s.salaryPerTick * TICKS_PER_HOUR,
      // ce que coûterait et apporterait l'augmentation demandée
      raiseSalaryPerHour: nextLevel ? salaryFor(s.role, nextLevel) * TICKS_PER_HOUR : null,
      effect: ROLES[s.role]?.effect(s.level) ?? "",
      nextEffect: nextLevel ? ROLES[s.role]?.effect(nextLevel) ?? null : null,
      // rames réellement prises en charge (les plus expérimentés servent en premier)
      covered: allocation.get(s.id) ?? null,
      savingsPerHour: Math.round(estimatedSavingsPerHour(s, allocation.get(s.id) ?? 0, effects, revenuePerHour)),
      hiredAt: s.hiredAt,
    };
  });

  const coverageOf = (role: string, cov: (l: number) => number) =>
    rows.filter((s) => s.role === role).reduce((sum, s) => sum + cov(s.level), 0);

  return res.json({
    members,
    trainCount,
    coverage: {
      MECANICIEN: Math.min(trainCount, coverageOf("MECANICIEN", mechanicCoverage)),
      CHEF_DEPOT: Math.min(trainCount, coverageOf("CHEF_DEPOT", chefCoverage)),
    },
    effects: {
      wearReduction: Math.round((1 - effects.wearMultiplier) * 100),
      repairReduction: Math.round((1 - effects.repairMultiplier) * 100),
      revenueBonus: Math.round((effects.revenueMultiplier - 1) * 100),
    },
    payrollPerHour: rows.reduce((sum, s) => sum + s.salaryPerTick, 0) * TICKS_PER_HOUR,
    roles: Object.entries(ROLES).map(([id, r]) => ({
      id,
      label: r.label,
      unique: r.unique,
      minGradeId: r.minGradeId,
      salaryPerHour: salaryFor(id, 1) * TICKS_PER_HOUR,
      effect: r.effect(1),
    })),
  });
}

/* Plafond d'effectif par poste. Il n'est pas là pour freiner — la couverture
   s'en charge, un employé de trop ne sert à rien — mais pour éviter qu'un clic
   répété n'embauche vingt mécaniciens par erreur. */
const MAX_PER_ROLE = 8;

export async function hireStaff(req: AuthRequest, res: Response) {
  const { role } = req.body;

  if (!role || !ROLES[role]) {
    return res.status(400).json({ error: "Rôle invalide" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const def = ROLES[role];
  if (def.minGradeId > 0) {
    const rows = await buildLeaderRows();
    const gradeId = rows.find((r) => r.id === company.id)?.gradeId ?? 0;
    if (gradeId < def.minGradeId) {
      return res.status(403).json({ error: "Ce poste demande le grade « Chef de réseau »" });
    }
  }

  const sameRole = await prisma.staff.count({ where: { companyId: company.id, role } });
  if (def.unique && sameRole > 0) {
    return res.status(409).json({ error: `Une compagnie n'a qu'un ${def.label.toLowerCase()}` });
  }
  if (sameRole >= MAX_PER_ROLE) {
    return res.status(409).json({ error: `Pas plus de ${MAX_PER_ROLE} employés à ce poste` });
  }

  const staff = await prisma.staff.create({
    data: {
      companyId: company.id,
      role,
      name: randomStaffName(),
      level: 1,
      xp: 0,
      salaryPerTick: salaryFor(role, 1),
    },
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

/* Réponse à une demande d'augmentation. Accorder fait monter d'UN niveau, même
   si l'ancienneté en justifierait deux : chaque palier est une décision, pas un
   rattrapage automatique. */
export async function answerRaise(req: AuthRequest, res: Response) {
  const { staffId, accept } = req.body;

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const staff = (await prisma.staff.findFirst({
    where: { id: staffId, companyId: company.id },
  })) as StaffRow | null;
  if (!staff) return res.status(404).json({ error: "Employé introuvable" });
  if (!staff.raiseRequested) return res.status(409).json({ error: "Aucune demande en attente" });

  if (!accept) {
    // il reste à son niveau et ne redemandera qu'après un nouveau palier de service
    await prisma.staff.update({
      where: { id: staff.id },
      data: { raiseRequested: false, refusedAtXp: staff.xp },
    });
    return res.json({ ok: true, level: staff.level });
  }

  const next = Math.min(MAX_LEVEL, staff.level + 1, levelFromXp(staff.xp));
  const updated = await prisma.staff.update({
    where: { id: staff.id },
    data: {
      level: next,
      salaryPerTick: salaryFor(staff.role, next),
      raiseRequested: false,
      refusedAtXp: 0,
    },
  });

  return res.json({ ok: true, level: updated.level });
}
