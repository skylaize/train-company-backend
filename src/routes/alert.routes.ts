import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { listAlerts, createAlert, deleteAlert } from "../controllers/alert.controller";

export const alertRouter = Router();

// 2.1.1 (Premium) : alertes personnalisées
alertRouter.get("/alerts", requireAuth, listAlerts);
alertRouter.post("/alerts", requireAuth, createAlert);
alertRouter.delete("/alerts/:id", requireAuth, deleteAlert);
