import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { createLine, listMyLines, updateLine, deleteLine } from "../controllers/line.controller";

export const lineRouter = Router();

lineRouter.post("/lines", requireAuth, createLine);
lineRouter.get("/lines", requireAuth, listMyLines);
lineRouter.patch("/lines", requireAuth, updateLine);
lineRouter.delete("/lines", requireAuth, deleteLine);
