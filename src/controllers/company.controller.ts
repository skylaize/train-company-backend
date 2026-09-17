import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { computeReputation } from "../services/reputation.service";

export async function createCompany(req: AuthRequest, res: Response) {
  const { name, liveryColor } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Le nom de la compagnie est requis" });
  }

  const existing = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (existing) {
    return res.status(409).json({ error: "Vous avez déjà une compagnie" });
  }

  const company = await prisma.company.create({
    data: {
      name,
      liveryColor: liveryColor || "#f2a900",
      ownerId: req.userId as string,
    },
  });

  await prisma.transaction.create({
    data: {
      companyId: company.id,
      type: "FONDATION",
      amount: company.balance,
      description: "Capital de fondation de la compagnie",
    },
  });

  return res.status(201).json(company);
}

export async function updateCompany(req: AuthRequest, res: Response) {
  const { name, liveryColor } = req.body;

  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Aucune compagnie trouvée pour cet utilisateur" });
  }

  if (name !== undefined && !name.trim()) {
    return res.status(400).json({ error: "Le nom ne peut pas être vide" });
  }

  const updated = await prisma.company.update({
    where: { id: company.id },
    data: {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(liveryColor !== undefined ? { liveryColor } : {}),
    },
  });

  return res.json(updated);
}

const MAX_FLEET_CAP = 6; // capacité maximale du dépôt en V1

export async function expandFleet(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  if (company.maxTrains >= MAX_FLEET_CAP) {
    return res.status(409).json({ error: "Capacité maximale du dépôt atteinte" });
  }

  const cost = company.maxTrains * 200;
  if (company.balance < cost) {
    return res.status(409).json({ error: `Trésorerie insuffisante (agrandissement : ${cost} pièces)` });
  }

  const [updated] = await prisma.$transaction([
    prisma.company.update({
      where: { id: company.id },
      data: { maxTrains: { increment: 1 }, balance: { decrement: cost } },
    }),
    prisma.transaction.create({
      data: {
        companyId: company.id,
        type: "EXPANSION_FLOTTE",
        amount: -cost,
        description: `Agrandissement du dépôt (+1 place, capacité ${company.maxTrains + 1})`,
      },
    }),
  ]);

  return res.json(updated);
}

export async function getMyCompany(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    include: { trains: true, lines: true },
  });

  if (!company) {
    return res.status(404).json({ error: "Aucune compagnie trouvée pour cet utilisateur" });
  }

  const reputation = await computeReputation(company.id);

  return res.json({ ...company, reputation });
}
