import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { buyTrain, assignTrainToLine, releaseTrain, renameTrain, repairTrain, listMyTrains, changeCars, setServicePlan, getParts, buyParts, sellTrain } from "../controllers/train.controller";

export const trainRouter = Router();

trainRouter.post("/trains", requireAuth, buyTrain);
trainRouter.post("/trains/assign", requireAuth, assignTrainToLine);
trainRouter.post("/trains/release", requireAuth, releaseTrain);
trainRouter.post("/trains/rename", requireAuth, renameTrain);
trainRouter.post("/trains/repair", requireAuth, repairTrain);
trainRouter.get("/trains", requireAuth, listMyTrains);
trainRouter.post("/trains/cars", requireAuth, changeCars);
// 2.0 : l'atelier, le magasin, la revente
trainRouter.post("/trains/service-plan", requireAuth, setServicePlan);
trainRouter.get("/trains/parts", requireAuth, getParts);
trainRouter.post("/trains/parts", requireAuth, buyParts);
trainRouter.post("/trains/sell", requireAuth, sellTrain);
