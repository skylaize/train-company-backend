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
// 2.6 : ce qui joue sur une rame (fiche de la rame)
trainRouter.get("/trains/:id/bonuses", requireAuth, async (req: AuthRequest, res: Response) => {
  const company = (await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true } })) as { id: string } | null;
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const bonuses = await trainBonuses(String(req.params.id), company.id);
  if (!bonuses) return res.status(404).json({ error: "Rame introuvable" });
  return res.json({ bonuses });
});
trainRouter.post("/trains/schedule", requireAuth, setTrainSchedule);
