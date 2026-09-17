import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

async function getOwnedCompanyOrFail(userId: string) {
  return prisma.company.findUnique({ where: { ownerId: userId } });
}

// Modèles d'offres tirées au sort pour réapprovisionner le marché
const CARGO_TEMPLATES = [
  { cargoType: "Céréales", originStation: "Chartres", destinationStation: "Le Mans", durationMinutes: 6, reward: 120, risky: false },
  { cargoType: "Acier", originStation: "Le Creusot", destinationStation: "Dijon", durationMinutes: 8, reward: 180, risky: false },
  { cargoType: "Conteneurs", originStation: "Le Havre", destinationStation: "Rouen", durationMinutes: 4, reward: 90, risky: false },
  { cargoType: "Bois", originStation: "Nancy", destinationStation: "Metz", durationMinutes: 5, reward: 100, risky: false },
  { cargoType: "Automobiles", originStation: "Sochaux", destinationStation: "Mulhouse", durationMinutes: 7, reward: 150, risky: false },
  { cargoType: "Produits chimiques", originStation: "Lyon", destinationStation: "Grenoble", durationMinutes: 6, reward: 140, risky: false },
  // marchandises fragiles : récompense nettement supérieure, mais risque de dommage en cours de route
  { cargoType: "Verre soufflé", originStation: "Nancy", destinationStation: "Strasbourg", durationMinutes: 5, reward: 230, risky: true },
  { cargoType: "Œuvres d'art", originStation: "Paris", destinationStation: "Lyon", durationMinutes: 8, reward: 340, risky: true },
  { cargoType: "Produits pharmaceutiques réfrigérés", originStation: "Strasbourg", destinationStation: "Mulhouse", durationMinutes: 4, reward: 190, risky: true },
];

const MIN_MARKET_SIZE = 3;
const EXPIRY_MINUTES = 5; // durée de vie d'une offre non acceptée sur le marché

export async function removeExpiredContracts() {
  await prisma.contract.deleteMany({
    where: { status: "DISPONIBLE", companyId: null, expiresAt: { lt: new Date() } },
  });
}

export async function ensureMarketStocked() {
  const available = await prisma.contract.count({ where: { status: "DISPONIBLE", companyId: null } });
  const missing = MIN_MARKET_SIZE - available;

  for (let i = 0; i < missing; i++) {
    const template = CARGO_TEMPLATES[Math.floor(Math.random() * CARGO_TEMPLATES.length)];
    await prisma.contract.create({
      data: { ...template, expiresAt: new Date(Date.now() + EXPIRY_MINUTES * 60_000) },
    });
  }
}

export async function listMarket(_req: AuthRequest, res: Response) {
  await removeExpiredContracts();
  await ensureMarketStocked();
  const contracts = await prisma.contract.findMany({
    where: { status: "DISPONIBLE", companyId: null },
    orderBy: { createdAt: "asc" },
  });
  return res.json(contracts);
}

export async function listMyContracts(req: AuthRequest, res: Response) {
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const contracts = await prisma.contract.findMany({
    where: { companyId: company.id },
    include: { train: true },
    orderBy: { createdAt: "desc" },
  });

  return res.json(contracts);
}

export async function acceptContract(req: AuthRequest, res: Response) {
  const { contractId, trainId } = req.body;

  if (!contractId || !trainId) {
    return res.status(400).json({ error: "contractId et trainId sont requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const contract = await prisma.contract.findUnique({ where: { id: contractId } });
  if (!contract || contract.status !== "DISPONIBLE" || contract.companyId) {
    return res.status(409).json({ error: "Ce contrat n'est plus disponible" });
  }
  if (contract.expiresAt && contract.expiresAt < new Date()) {
    await prisma.contract.delete({ where: { id: contractId } });
    return res.status(409).json({ error: "Ce contrat vient d'expirer" });
  }

  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) {
    return res.status(404).json({ error: "Train introuvable" });
  }
  if (train.status !== "IDLE" || train.lineId) {
    return res.status(409).json({ error: "Ce train n'est pas disponible (déjà en service)" });
  }
  if (train.wear >= 100) {
    return res.status(409).json({ error: "Ce train doit être réparé avant de pouvoir circuler" });
  }

  const [updatedContract] = await prisma.$transaction([
    prisma.contract.update({
      where: { id: contractId },
      data: { companyId: company.id, trainId, status: "EN_COURS", acceptedAt: new Date() },
    }),
    prisma.train.update({
      where: { id: trainId },
      data: { status: "EN_ROUTE", progress: 0, departedAt: new Date() },
    }),
  ]);

  return res.status(201).json(updatedContract);
}
