import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getInfrastructure, electrifyLine, buyStation, upgradeStation, sellStation, openWorkshop, closeWorkshop } from "../controllers/infrastructure.controller";

export const infrastructureRouter = Router();

infrastructureRouter.get("/infrastructure", requireAuth, getInfrastructure);
infrastructureRouter.post("/infrastructure/electrify", requireAuth, electrifyLine);
infrastructureRouter.post("/infrastructure/stations/buy", requireAuth, buyStation);
infrastructureRouter.post("/infrastructure/stations/upgrade", requireAuth, upgradeStation);
infrastructureRouter.post("/infrastructure/stations/sell", requireAuth, sellStation);
infrastructureRouter.post("/infrastructure/workshops", requireAuth, openWorkshop);
infrastructureRouter.post("/infrastructure/workshops/close", requireAuth, closeWorkshop);
