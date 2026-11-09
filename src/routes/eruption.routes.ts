import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getEruption, repairSubStation } from "../controllers/eruption.controller";

// 2.7 : éruption solaire
export const eruptionRouter = Router();

eruptionRouter.get("/eruption", requireAuth, getEruption);
eruptionRouter.post("/eruption/:region/repair", requireAuth, repairSubStation);
