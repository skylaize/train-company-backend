import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getConstructions, startConstruction, cancelQueuedConstruction } from "../controllers/construction.controller";

export const constructionRouter = Router();

constructionRouter.get("/constructions", requireAuth, getConstructions);
constructionRouter.post("/constructions", requireAuth, startConstruction);
constructionRouter.post("/constructions/queue/cancel", requireAuth, cancelQueuedConstruction);
