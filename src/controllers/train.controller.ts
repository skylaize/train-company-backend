import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

async function getOwnedCompanyOrFail(userId: string) {
  return prisma.company.findUnique({ where: { ownerId: userId } });
}

const TRAIN_MODELS: Record<string, { cost: number; premium: boolean }> = {
  STANDARD: { cost: 200, premium: false },
  EXPRESS: { cost: 450, premium: true },
  FRET_LOURD: { cost: 450, premium: true },
};

export async function buyTrain(req: AuthRequest, res: Response) {
  const { name, model } = req.body;
  const chosenModel = model && TRAIN_MODELS[model] ? model : "STANDARD";
  const { cost: TRAIN_COST, premium } = TRAIN_MODELS[chosenModel];

  if (!name) {
    return res.status(400).json({ error: "Le nom du train est requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  if (premium && !company.isPremium) {
    return res.status(403).json({ error: "Ce modèle est réservé aux compagnies Premium" });
  }

  const trainCount = await prisma.train.count({ where: { companyId: company.id } });
  if (trainCount >= company.maxTrains) {
    return res.status(403).json({ error: `Capacité du dépôt atteinte (${company.maxTrains} rames). Agrandissez-le pour continuer.` });
  }

  if (company.balance < TRAIN_COST) {
    return res.status(409).json({ error: `Trésorerie insuffisante (achat : ${TRAIN_COST} pièces)` });
  }

  const [train] = await prisma.$transaction([
    prisma.train.create({ data: { name, model: chosenModel, companyId: company.id } }),
    prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: TRAIN_COST } } }),
    prisma.transaction.create({
      data: {
        companyId: company.id,
        type: "ACHAT_TRAIN",
        amount: -TRAIN_COST,
        description: `Achat de ${name}`,
      },
    }),
  ]);

  return res.status(201).json(train);
}

export async function assignTrainToLine(req: AuthRequest, res: Response) {
  const { trainId, lineId } = req.body;

  if (!trainId || !lineId) {
    return res.status(400).json({ error: "trainId et lineId sont requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) {
    return res.status(404).json({ error: "Train introuvable" });
  }
  if (train.status !== "IDLE") {
    return res.status(409).json({ error: "Ce train est déjà en service (ligne ou fret en cours)" });
  }
  if (train.wear >= 100) {
    return res.status(409).json({ error: "Ce train doit être réparé avant de pouvoir circuler" });
  }

  const line = await prisma.line.findFirst({ where: { id: lineId, companyId: company.id } });
  if (!line) {
    return res.status(404).json({ error: "Ligne introuvable" });
  }

  const updated = await prisma.train.update({
    where: { id: trainId },
    data: {
      lineId,
      status: "EN_ROUTE",
      progress: 0,
      departedAt: new Date(),
    },
  });

  return res.json(updated);
}

const REPAIR_COST_PER_POINT = 2; // pièces par point d'usure à réparer (réduit pour éviter qu'une double panne ne bloque un nouveau joueur)

export async function repairTrain(req: AuthRequest, res: Response) {
  const { trainId } = req.body;

  if (!trainId) {
    return res.status(400).json({ error: "trainId est requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) {
    return res.status(404).json({ error: "Train introuvable" });
  }
  if (train.wear === 0) {
    return res.status(409).json({ error: "Ce train n'a pas besoin de réparation" });
  }

  const hasChefDepot = await prisma.staff.count({ where: { companyId: company.id, role: "CHEF_DEPOT" } }) > 0;
  const costPerPoint = hasChefDepot ? (company.isPremium ? 0.5 : 1) : REPAIR_COST_PER_POINT;
  const cost = Math.ceil(train.wear * costPerPoint);
  if (company.balance < cost) {
    return res.status(409).json({ error: `Trésorerie insuffisante (réparation : ${cost} pièces)` });
  }

  const resumesLine = train.status === "MAINTENANCE" && train.lineId;

  const [updatedTrain] = await prisma.$transaction([
    prisma.train.update({
      where: { id: trainId },
      data: resumesLine
        ? { wear: 0, status: "EN_ROUTE", progress: 0, departedAt: new Date() }
        : { wear: 0 },
    }),
    prisma.company.update({
      where: { id: company.id },
      data: { balance: { decrement: cost } },
    }),
    prisma.transaction.create({
      data: {
        companyId: company.id,
        type: "REPARATION",
        amount: -cost,
        description: `Réparation de ${train.name}`,
      },
    }),
  ]);

  return res.json(updatedTrain);
}

export async function renameTrain(req: AuthRequest, res: Response) {
  const { trainId, name } = req.body;

  if (!trainId || !name) {
    return res.status(400).json({ error: "trainId et name sont requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) {
    return res.status(404).json({ error: "Train introuvable" });
  }

  const updated = await prisma.train.update({ where: { id: trainId }, data: { name } });
  return res.json(updated);
}

export async function releaseTrain(req: AuthRequest, res: Response) {
  const { trainId } = req.body;

  if (!trainId) {
    return res.status(400).json({ error: "trainId est requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) {
    return res.status(404).json({ error: "Train introuvable" });
  }
  if (!train.lineId) {
    return res.status(409).json({ error: "Ce train n'est affecté à aucune ligne" });
  }
  if (train.status === "MAINTENANCE") {
    return res.status(409).json({ error: "Ce train est en panne, réparez-le d'abord" });
  }

  const updated = await prisma.train.update({
    where: { id: trainId },
    data: { lineId: null, status: "IDLE", progress: 0, departedAt: null },
  });

  return res.json(updated);
}

export async function listMyTrains(req: AuthRequest, res: Response) {
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const trains = await prisma.train.findMany({
    where: { companyId: company.id },
    include: { line: true },
  });

  return res.json(trains);
}
