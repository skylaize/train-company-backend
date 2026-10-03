import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getLoans, takeLoan, repayLoan, getWeeklyReport, getReportHistory, getMarket, buyShares, sellShares, createOrder, cancelOrder } from "../controllers/finance.controller";

export const financeRouter = Router();

financeRouter.get("/finance/loans", requireAuth, getLoans);
financeRouter.post("/finance/loans", requireAuth, takeLoan);
financeRouter.post("/finance/loans/repay", requireAuth, repayLoan);
financeRouter.get("/finance/report", requireAuth, getWeeklyReport);
financeRouter.get("/bourse", requireAuth, getMarket);
financeRouter.post("/bourse/buy", requireAuth, buyShares);
financeRouter.post("/bourse/sell", requireAuth, sellShares);
financeRouter.get("/finance/report/history", requireAuth, getReportHistory);
financeRouter.post("/bourse/orders", requireAuth, createOrder);
financeRouter.delete("/bourse/orders/:id", requireAuth, cancelOrder);
