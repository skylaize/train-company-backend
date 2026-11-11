import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getInfrastructure, electrifyLine, buyStation, bidStation, upgradeStation, sellStation, openWorkshop, closeWorkshop, doubleLine, openYard, closeYard, buildHighSpeed, buyShop, sellShop, toggleWatch, shopAdvisor } from "../controllers/infrastructure.controller";

export const infrastructureRouter = Router();

infrastructureRouter.get("/infrastructure", requireAuth, getInfrastructure);
infrastructureRouter.post("/infrastructure/electrify", requireAuth, electrifyLine);
infrastructureRouter.post("/infrastructure/stations/buy", requireAuth, buyStation);
infrastructureRouter.post("/infrastructure/stations/bid", requireAuth, bidStation); // 2.7 : enchères
infrastructureRouter.post("/infrastructure/stations/upgrade", requireAuth, upgradeStation);
infrastructureRouter.post("/infrastructure/stations/sell", requireAuth, sellStation);
infrastructureRouter.post("/infrastructure/workshops", requireAuth, openWorkshop);
infrastructureRouter.post("/infrastructure/workshops/close", requireAuth, closeWorkshop);
// 2.1
infrastructureRouter.post("/infrastructure/double", requireAuth, doubleLine);
infrastructureRouter.post("/infrastructure/yards", requireAuth, openYard);
infrastructureRouter.post("/infrastructure/yards/close", requireAuth, closeYard);
// 2.2
infrastructureRouter.post("/infrastructure/high-speed", requireAuth, buildHighSpeed);
// 2.6 : commerces, gares surveillées, conseiller (Premium)
infrastructureRouter.post("/infrastructure/shops/buy", requireAuth, buyShop);
infrastructureRouter.post("/infrastructure/shops/sell", requireAuth, sellShop);
infrastructureRouter.post("/infrastructure/stations/watch", requireAuth, toggleWatch);
infrastructureRouter.get("/infrastructure/shops/advisor", requireAuth, shopAdvisor);
