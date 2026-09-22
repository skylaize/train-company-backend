import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import {
  quoteFor,
  activeConstruction,
  queuedConstruction,
  orderConstruction,
  cancelQueued,
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

  const [current, queued, warehouse, recent] = await Promise.all([
    activeConstruction(company.id),
    queuedConstruction(company.id),
    prisma.warehouse.findUnique({ where: { companyId: company.id } }),
    prisma.construction.findMany({
      where: { companyId: company.id, done: true },
      orderBy: { endsAt: "desc" },
      take: 5,
    }),
  ]);

  /* Pendant un chantier, les devis portent sur l'état d'APRÈS : c'est ce que
     coûterait le chantier mis en file. */
  const quotes = await Promise.all(KINDS.map((k) => quoteFor(company.id, k, current ? current.kind : null)));

  return res.json({
    current,
    queued,
    // la file : Premium, un seul chantier en attente, et seulement s'il y a un chantier en cours
    canQueue: company.isPremium && Boolean(current) && !queued,
    isPremium: company.isPremium,
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

  /* Un seul chantier à la fois reste la règle : la file Premium n'en fait pas
     avancer deux, elle en fait seulement attendre un. */
  const result = await orderConstruction(company.id, kind);
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  return res.status(201).json({ ...(result.construction as object), queued: result.queued });
}

export async function cancelQueuedConstruction(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const result = await cancelQueued(company.id);
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  return res.json(result);
}
