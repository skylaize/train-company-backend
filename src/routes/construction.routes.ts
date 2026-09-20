import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getConstructions, startConstruction } from "../controllers/construction.controller";

export const constructionRouter = Router();

constructionRouter.get("/constructions", requireAuth, getConstructions);
constructionRouter.post("/constructions", requireAuth, startConstruction);
