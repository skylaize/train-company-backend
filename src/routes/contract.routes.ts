import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { listMarket, listMyContracts, acceptContract } from "../controllers/contract.controller";

export const contractRouter = Router();

contractRouter.get("/contracts/market", requireAuth, listMarket);
contractRouter.get("/contracts/mine", requireAuth, listMyContracts);
contractRouter.post("/contracts/accept", requireAuth, acceptContract);
