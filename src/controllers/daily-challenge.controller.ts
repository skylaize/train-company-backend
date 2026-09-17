import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

const TEMPLATES = [
  { type: "LIVRAISONS", target: 2, reward: 150, label: "Livrer 2 contrats de fret aujourd'hui" },
  { type: "REPARATIONS", target: 1, reward: 100, label: "Réparer une rame aujourd'hui" },
  { type: "NOUVELLE_LIGNE", target: 1, reward: 80, label: "Créer une nouvelle ligne aujourd'hui" },
];

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function startOfToday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function computeProgress(companyId: string, type: string): Promise<number> {
  const since = startOfToday();
  switch (type) {
    case "LIVRAISONS":
      return prisma.transaction.count({ where: { companyId, type: "FRET", createdAt: { gte: since } } });
    case "REPARATIONS":
      return prisma.transaction.count({ where: { companyId, type: "REPARATION", createdAt: { gte: since } } });
    case "NOUVELLE_LIGNE":
      return prisma.line.count({ where: { companyId, createdAt: { gte: since } } });
    default:
      return 0;
  }
}

export async function getMyDailyChallenge(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const date = todayKey();

  let challenge = await prisma.dailyChallenge.findUnique({
    where: { companyId_date: { companyId: company.id, date } },
  });

  if (!challenge) {
    const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
    challenge = await prisma.dailyChallenge.create({
      data: { companyId: company.id, date, type: template.type, target: template.target, reward: template.reward },
    });
  }

  const template = TEMPLATES.find((t) => t.type === challenge!.type)!;
  const progress = await computeProgress(company.id, challenge.type);

  return res.json({
    type: challenge.type,
    label: template.label,
    target: challenge.target,
    reward: challenge.reward,
    progress: Math.min(progress, challenge.target),
    completed: progress >= challenge.target,
    claimed: challenge.claimed,
  });
}

export async function claimDailyChallenge(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const date = todayKey();
  const challenge = await prisma.dailyChallenge.findUnique({
    where: { companyId_date: { companyId: company.id, date } },
  });

  if (!challenge) {
    return res.status(404).json({ error: "Aucun défi actif aujourd'hui" });
  }
  if (challenge.claimed) {
    return res.status(409).json({ error: "Récompense déjà récupérée" });
  }

  const progress = await computeProgress(company.id, challenge.type);
  if (progress < challenge.target) {
    return res.status(409).json({ error: "Défi pas encore terminé" });
  }

  const template = TEMPLATES.find((t) => t.type === challenge.type)!;

  await prisma.$transaction([
    prisma.dailyChallenge.update({ where: { id: challenge.id }, data: { claimed: true } }),
    prisma.company.update({ where: { id: company.id }, data: { balance: { increment: challenge.reward } } }),
    prisma.transaction.create({
      data: {
        companyId: company.id,
        type: "DEFI_QUOTIDIEN",
        amount: challenge.reward,
        description: `Défi quotidien accompli : ${template.label}`,
      },
    }),
  ]);

  return res.json({ success: true });
}
