import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import * as eco from "../controllers/economy.controller";

/* 2.4 : le vrai coût du rail — énergie, carbone, pièces, voies. */
export const economyRouter = Router();

economyRouter.get("/economy/energy", requireAuth, eco.energyOverview);
economyRouter.post("/economy/tanks", requireAuth, eco.buyTanks);
economyRouter.post("/economy/tanks/fill", requireAuth, eco.fillTanks);
economyRouter.post("/economy/contracts", requireAuth, eco.lockPrice);
economyRouter.post("/economy/plants", requireAuth, eco.buildPlant);
economyRouter.delete("/economy/plants/:id", requireAuth, eco.sellPlant);
economyRouter.patch("/economy/settings", requireAuth, eco.energySettings);

economyRouter.get("/economy/parts", requireAuth, eco.partsOverview);
economyRouter.post("/economy/factories", requireAuth, eco.buildFactory);
economyRouter.patch("/economy/factories/:id", requireAuth, eco.updateFactory);
economyRouter.post("/economy/factories/:id/collect", requireAuth, eco.collectFactory);
economyRouter.post("/economy/parts/buy", requireAuth, eco.buyFromPlayer);

economyRouter.get("/economy/track", requireAuth, eco.trackOverview);
economyRouter.get("/economy/track/map", requireAuth, eco.trackMap);
economyRouter.post("/economy/track/fund", requireAuth, eco.fundTrack);
economyRouter.post("/economy/concessions", requireAuth, eco.buyConcession);
economyRouter.patch("/economy/concessions/:id", requireAuth, eco.updateConcession);
economyRouter.delete("/economy/concessions/:id", requireAuth, eco.sellConcession);
