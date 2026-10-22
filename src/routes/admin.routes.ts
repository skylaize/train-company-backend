import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware";
import * as admin from "../controllers/admin.controller";

/* 2.2 : panneau d'administration. Tout ce routeur est réservé aux
   adresses de ADMIN_EMAILS. */
export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/me", admin.adminMe);
adminRouter.get("/overview", admin.overview);

adminRouter.get("/players", admin.listPlayers);
adminRouter.get("/players/:id", admin.playerDetail);
adminRouter.patch("/players/:id", admin.updatePlayer);
adminRouter.post("/players/:id/coins", admin.adjustCoins);
adminRouter.post("/players/:id/premium", admin.setPremium);
adminRouter.post("/players/:id/items", admin.grantItem);
adminRouter.delete("/players/:id/items/:itemId", admin.revokeItem);
adminRouter.post("/players/:id/ban", admin.banPlayer);
adminRouter.delete("/players/:id/ban", admin.unbanPlayer);
adminRouter.post("/players/:id/season-points", admin.adjustSeasonPoints);

adminRouter.get("/seasons", admin.seasons);
adminRouter.patch("/seasons/:id", admin.updateSeason);
adminRouter.patch("/world", admin.updateWorld);

adminRouter.get("/alliances", admin.listAlliances);
adminRouter.patch("/alliances/:id", admin.updateAllianceAdmin);
adminRouter.delete("/alliances/:id", admin.dissolveAlliance);
adminRouter.delete("/alliances/:id/members/:companyId", admin.kickFromAlliance);

adminRouter.get("/shop", admin.shop);

adminRouter.get("/giveaways", admin.listGiveaways);
adminRouter.post("/giveaways", admin.launchGiveaway);
adminRouter.post("/giveaways/:id/finish", admin.endGiveaway);
adminRouter.post("/giveaways/:id/reroll", admin.rerollGiveawayAdmin);

adminRouter.get("/announcements", admin.listAnnouncements);
adminRouter.post("/announcements", admin.createAnnouncement);

adminRouter.get("/logs", admin.adminLogs);
