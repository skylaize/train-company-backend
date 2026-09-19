import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getMyCareer } from "../controllers/career.controller";

export const careerRouter = Router();

careerRouter.get("/career/mine", requireAuth, getMyCareer);
