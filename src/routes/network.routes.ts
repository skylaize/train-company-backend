import { Router } from "express";
import { getNetworkStats, getNetworkMap } from "../controllers/network.controller";
import { requireAuth } from "../middleware/auth.middleware";

export const networkRouter = Router();

networkRouter.get("/network/stats", getNetworkStats);
networkRouter.get("/network/map", requireAuth, getNetworkMap);
