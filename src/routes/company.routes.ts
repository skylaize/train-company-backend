import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { createCompany, getMyCompany, updateCompany, expandFleet, togglePremiumTest } from "../controllers/company.controller";

export const companyRouter = Router();

companyRouter.post("/company", requireAuth, createCompany);
companyRouter.get("/company", requireAuth, getMyCompany);
companyRouter.patch("/company", requireAuth, updateCompany);
companyRouter.post("/company/expand-fleet", requireAuth, expandFleet);
companyRouter.post("/company/toggle-premium-test", requireAuth, togglePremiumTest);
