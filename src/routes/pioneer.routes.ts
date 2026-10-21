import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getMyPioneer, getPioneerMap } from "../controllers/pioneer.controller";

export const pioneerRouter = Router();

pioneerRouter.get("/pioneers/mine", requireAuth, getMyPioneer);
pioneerRouter.get("/pioneers/map", requireAuth, getPioneerMap);
