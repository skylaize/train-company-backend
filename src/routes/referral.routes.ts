import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getMyReferral } from "../controllers/referral.controller";

export const referralRouter = Router();

referralRouter.get("/referral/mine", requireAuth, getMyReferral);
