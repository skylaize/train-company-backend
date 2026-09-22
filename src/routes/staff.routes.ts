import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { listMyStaff, getStaffOverview, hireStaff, fireStaff, answerRaise } from "../controllers/staff.controller";

export const staffRouter = Router();

staffRouter.get("/staff/mine", requireAuth, listMyStaff);
staffRouter.get("/staff/overview", requireAuth, getStaffOverview);
staffRouter.post("/staff/hire", requireAuth, hireStaff);
staffRouter.post("/staff/fire", requireAuth, fireStaff);
staffRouter.post("/staff/raise", requireAuth, answerRaise);
