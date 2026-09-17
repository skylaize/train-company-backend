import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getMyDailyChallenge, claimDailyChallenge } from "../controllers/daily-challenge.controller";

export const dailyChallengeRouter = Router();

dailyChallengeRouter.get("/daily-challenge/mine", requireAuth, getMyDailyChallenge);
dailyChallengeRouter.post("/daily-challenge/claim", requireAuth, claimDailyChallenge);
