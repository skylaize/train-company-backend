import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getBillingStatus, createCheckoutSession } from "../controllers/billing.controller";

export const billingRouter = Router();

billingRouter.get("/billing/status", requireAuth, getBillingStatus);
billingRouter.post("/billing/checkout", requireAuth, createCheckoutSession);
