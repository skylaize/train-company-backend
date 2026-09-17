import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { listMyStaff, hireStaff, fireStaff } from "../controllers/staff.controller";

export const staffRouter = Router();

staffRouter.get("/staff/mine", requireAuth, listMyStaff);
staffRouter.post("/staff/hire", requireAuth, hireStaff);
staffRouter.post("/staff/fire", requireAuth, fireStaff);
