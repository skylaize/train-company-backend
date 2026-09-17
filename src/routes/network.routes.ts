import { Router } from "express";
import { getNetworkStats } from "../controllers/network.controller";

export const networkRouter = Router();

networkRouter.get("/network/stats", getNetworkStats);
