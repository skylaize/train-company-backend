import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import {
  quoteFor,
  activeConstruction,
  ConstructionKind,
  WAREHOUSE_CAPACITY_STEP,
} from "../services/construction.service";

const KINDS: ConstructionKind[] = ["DEPOT", "ENTREPOT", "ENTREPOT_AGRANDISSEMENT"];

async function companyOf(req: AuthRequest) {
  return prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true, balance: true, maxTrains: true, isPremium: true },
  });
}

export async function getConstructions(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const [current, quotes, warehouse, recent] = await Promise.all([
    activeConstruction(company.id),
    Promise.all(KINDS.map((k) => quoteFor(company.id, k))),
    prisma.warehouse.findUnique({ where: { companyId: company.id } }),
    prisma.construction.findMany({
      where: { companyId: company.id, done: true },
      orderBy: { endsAt: "desc" },
      take: 5,
    }),
  ]);

  return res.json({
    current,
    quotes: quotes.filter(Boolean),
    warehouse,
    capacityStep: WAREHOUSE_CAPACITY_STEP,
    balance: company.balance,
    recent,
  });
}

export async function startConstruction(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const kind = req.body.kind as ConstructionKind;
  if (!KINDS.includes(kind)) {
    return res.status(400).json({ error: "Type de chantier inconnu" });
  }

  /* Un seul chantier à la fois : c'est toute la règle. Sans elle, une grosse
     trésorerie lancerait dix chantiers en parallèle et le temps cesserait
     d'être une contrainte. */
  const running = await activeConstruction(company.id);
  if (running) {
    return res.status(409).json({ error: "Un chantier est déjà en cours" });
  }

  const quote = await quoteFor(company.id, kind);
  if (!quote) return res.status(404).json({ error: "Devis indisponible" });
  if (!quote.available) {
    return res.status(409).json({ error: quote.reason ?? "Ce chantier n'est pas disponible" });
  }
  if (company.balance < quote.cost) {
    return res.status(409).json({ error: `Trésorerie insuffisante (${quote.cost} pièces)` });
  }

  const endsAt = new Date(Date.now() + quote.hours * 3600_000);

  const [construction] = await prisma.$transaction([
    prisma.construction.create({
      data: {
        companyId: company.id,
        kind,
        label: quote.label,
        cost: quote.cost,
        endsAt,
      },
    }),
    prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: quote.cost } } }),
    prisma.transaction.create({
      data: {
        companyId: company.id,
        type: "CHANTIER",
        amount: -quote.cost,
        description: `${quote.label} — chantier lancé`,
      },
    }),
  ]);

  return res.status(201).json(construction);
}
