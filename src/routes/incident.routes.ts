import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { listMyIncidents } from "../controllers/incident.controller";

export const incidentRouter = Router();

incidentRouter.get("/incidents/mine", requireAuth, listMyIncidents);
