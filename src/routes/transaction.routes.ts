import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { listMyTransactions } from "../controllers/transaction.controller";

export const transactionRouter = Router();

transactionRouter.get("/transactions/mine", requireAuth, listMyTransactions);
