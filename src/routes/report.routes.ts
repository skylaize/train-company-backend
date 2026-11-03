import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getProfitability, getAbsenceReport, dismissAbsenceReport, getBalanceHistory } from "../controllers/report.controller";

export const reportRouter = Router();

reportRouter.get("/stats/profitability", requireAuth, getProfitability);
reportRouter.get("/report/absence", requireAuth, getAbsenceReport);
reportRouter.post("/report/absence/dismiss", requireAuth, dismissAbsenceReport);
reportRouter.get("/stats/balance", requireAuth, getBalanceHistory); // 2.6
