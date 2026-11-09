import { Router, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { trainBonuses } from "../services/bonus.service";
import { buyTrain, assignTrainToLine, releaseTrain, renameTrain, repairTrain, listMyTrains, changeCars, setServicePlan, getParts, buyParts, sellTrain, setTrainPlate, trainResale, setTrainSchedule } from "../controllers/train.controller";

export const trainRouter = Router();

trainRouter.post("/trains", requireAuth, buyTrain);
trainRouter.post("/trains/assign", requireAuth, assignTrainToLine);
trainRouter.post("/trains/release", requireAuth, releaseTrain);
trainRouter.post("/trains/rename", requireAuth, renameTrain);
trainRouter.post("/trains/repair", requireAuth, repairTrain);
trainRouter.get("/trains", requireAuth, listMyTrains);
trainRouter.post("/trains/cars", requireAuth, changeCars);
trainRouter.post("/trains/plate", requireAuth, setTrainPlate); // 2.1
// 2.0 : l'atelier, le magasin, la revente
trainRouter.post("/trains/service-plan", requireAuth, setServicePlan);
trainRouter.get("/trains/parts", requireAuth, getParts);
trainRouter.post("/trains/parts", requireAuth, buyParts);
trainRouter.post("/trains/sell", requireAuth, sellTrain);
// 2.1.1 (Premium)
trainRouter.get("/trains/:id/resale", requireAuth, trainResale);
/* 2.7 : vue cabine — les rames des autres compagnies qui roulent sur au moins
   un tronçon de la ligne de cette rame, pour les croiser en route. Une seule
   requête sur les rames en route (index sur le statut), filtrée en mémoire,
   et gardée 30 s par ligne : la vue cabine interroge toutes les minutes. */
const rivalCache = new Map<string, { at: number; rows: unknown[] }>();
trainRouter.get("/trains/:id/rivals", requireAuth, async (req: AuthRequest, res: Response) => {
  const company = (await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true } })) as { id: string } | null;
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const me = (await prisma.train.findFirst({
    where: { id: String(req.params.id), companyId: company.id },
    select: { line: { select: { id: true, departureStation: true, arrivalStation: true, stops: true } } },
  })) as { line: { id: string; departureStation: string; arrivalStation: string; stops: string[] } | null } | null;
  if (!me?.line) return res.json({ rivals: [] });
  const cached = rivalCache.get(me.line.id);
  if (cached && Date.now() - cached.at < 30_000) return res.json({ rivals: cached.rows.filter((r) => (r as { companyId: string }).companyId !== company.id) });
  const mine = [me.line.departureStation, ...(me.line.stops ?? []), me.line.arrivalStation];
  const pairs = new Set<string>();
  for (let i = 0; i < mine.length - 1; i++) pairs.add([mine[i], mine[i + 1]].sort().join("|"));
  const running = (await prisma.train.findMany({
    where: { status: "EN_ROUTE", lineId: { not: null } },
    select: {
      id: true, name: true, model: true, cars: true, direction: true, departedAt: true, heritage: true, companyId: true,
      company: { select: { name: true, liveryColor: true } },
      line: { select: { id: true, departureStation: true, arrivalStation: true, stops: true, durationMinutes: true, electrified: true, doubleTrack: true, highSpeedAt: true } },
    },
  })) as { companyId: string; line: { departureStation: string; arrivalStation: string; stops: string[] } | null }[];
  const rows = running
    .filter((t) => {
      if (!t.line) return false;
      const r = [t.line.departureStation, ...(t.line.stops ?? []), t.line.arrivalStation];
      for (let i = 0; i < r.length - 1; i++) if (pairs.has([r[i], r[i + 1]].sort().join("|"))) return true;
      return false;
    })
    .slice(0, 40);
  rivalCache.set(me.line.id, { at: Date.now(), rows });
  return res.json({ rivals: rows.filter((r) => r.companyId !== company.id).slice(0, 12) });
});

// 2.6 : ce qui joue sur une rame (fiche de la rame)
trainRouter.get("/trains/:id/bonuses", requireAuth, async (req: AuthRequest, res: Response) => {
  const company = (await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true } })) as { id: string } | null;
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const bonuses = await trainBonuses(String(req.params.id), company.id);
  if (!bonuses) return res.status(404).json({ error: "Rame introuvable" });
  return res.json({ bonuses });
});
trainRouter.post("/trains/schedule", requireAuth, setTrainSchedule);
