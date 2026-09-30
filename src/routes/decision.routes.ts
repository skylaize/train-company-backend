import { Router } from "express";
import { chooseDecision, listDecisions, listNews } from "../controllers/decision.controller";
import { requireAuth } from "../middleware/auth.middleware";

export const decisionRouter = Router();

decisionRouter.get("/decisions", requireAuth, listDecisions);
decisionRouter.post("/decisions/:id/choose", requireAuth, chooseDecision);
decisionRouter.get("/news", requireAuth, listNews);
