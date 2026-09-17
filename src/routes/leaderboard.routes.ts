import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getLeaderboard } from "../controllers/leaderboard.controller";

export const leaderboardRouter = Router();

leaderboardRouter.get("/leaderboard", requireAuth, getLeaderboard);
