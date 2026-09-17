import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { buyTrain, assignTrainToLine, releaseTrain, renameTrain, repairTrain, listMyTrains } from "../controllers/train.controller";

export const trainRouter = Router();

trainRouter.post("/trains", requireAuth, buyTrain);
trainRouter.post("/trains/assign", requireAuth, assignTrainToLine);
trainRouter.post("/trains/release", requireAuth, releaseTrain);
trainRouter.post("/trains/rename", requireAuth, renameTrain);
trainRouter.post("/trains/repair", requireAuth, repairTrain);
trainRouter.get("/trains", requireAuth, listMyTrains);
