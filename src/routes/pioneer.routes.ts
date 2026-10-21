import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getMyPioneer, getPioneerMap } from "../controllers/pioneer.controller";
import { getTrain200 } from "../controllers/train200.controller";

export const pioneerRouter = Router();

pioneerRouter.get("/pioneers/mine", requireAuth, getMyPioneer);
pioneerRouter.get("/pioneers/map", requireAuth, getPioneerMap);
pioneerRouter.get("/train200", requireAuth, getTrain200);
