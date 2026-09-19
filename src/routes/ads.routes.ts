import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getAdStatus, claimAdReward } from "../controllers/ads.controller";

export const adsRouter = Router();

adsRouter.get("/ads/status", requireAuth, getAdStatus);
adsRouter.post("/ads/claim", requireAuth, claimAdReward);
