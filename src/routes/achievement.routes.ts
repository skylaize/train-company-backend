import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { listMyAchievements } from "../controllers/achievement.controller";

export const achievementRouter = Router();

achievementRouter.get("/achievements/mine", requireAuth, listMyAchievements);
