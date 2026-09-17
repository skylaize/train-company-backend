import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getTodaySummary } from "../controllers/summary.controller";

export const summaryRouter = Router();

summaryRouter.get("/summary/today", requireAuth, getTodaySummary);
