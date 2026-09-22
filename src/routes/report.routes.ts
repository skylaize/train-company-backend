import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getProfitability, getAbsenceReport, dismissAbsenceReport } from "../controllers/report.controller";

export const reportRouter = Router();

reportRouter.get("/stats/profitability", requireAuth, getProfitability);
reportRouter.get("/report/absence", requireAuth, getAbsenceReport);
reportRouter.post("/report/absence/dismiss", requireAuth, dismissAbsenceReport);
