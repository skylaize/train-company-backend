import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getBillingStatus, createCheckoutSession, confirmCheckout } from "../controllers/billing.controller";

export const billingRouter = Router();

billingRouter.get("/billing/status", requireAuth, getBillingStatus);
billingRouter.post("/billing/checkout", requireAuth, createCheckoutSession);
// 2.0 : au retour de Stripe, le jeu redemande la session (sans attendre le webhook)
billingRouter.post("/billing/confirm", requireAuth, confirmCheckout);
