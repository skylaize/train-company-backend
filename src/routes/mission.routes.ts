import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getMyClients, acceptMission, declineMission } from "../controllers/mission.controller";

export const missionRouter = Router();

missionRouter.get("/clients/mine", requireAuth, getMyClients);
missionRouter.post("/missions/:id/accept", requireAuth, acceptMission);
missionRouter.post("/missions/:id/decline", requireAuth, declineMission);
