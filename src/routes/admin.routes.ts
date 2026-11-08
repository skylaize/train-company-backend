import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware";
import * as admin from "../controllers/admin.controller";

/* 2.2 : panneau d'administration. Tout ce routeur est réservé aux
   adresses de ADMIN_EMAILS. */
export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/me", admin.adminMe);
adminRouter.get("/overview", admin.overview);
adminRouter.get("/onboarding", admin.onboardingFunnel); // 2.6.1

adminRouter.get("/players", admin.listPlayers);
adminRouter.get("/players/:id", admin.playerDetail);
adminRouter.patch("/players/:id", admin.updatePlayer);
adminRouter.post("/players/:id/coins", admin.adjustCoins);
adminRouter.post("/players/:id/premium", admin.setPremium);
adminRouter.post("/players/:id/items", admin.grantItem);
adminRouter.delete("/players/:id/items/:itemId", admin.revokeItem);
adminRouter.post("/players/:id/ban", admin.banPlayer);
adminRouter.delete("/players/:id/ban", admin.unbanPlayer);
adminRouter.post("/players/:id/warn", admin.warnPlayer);
adminRouter.post("/players/:id/season-points", admin.adjustSeasonPoints);
adminRouter.post("/players/:id/trains/:trainId/reset", admin.resetTrain);
adminRouter.delete("/players/:id/trains/:trainId", admin.removeTrain);

adminRouter.get("/seasons", admin.seasons);
adminRouter.patch("/seasons/:id", admin.updateSeason);
adminRouter.patch("/world", admin.updateWorld);
// 2.4 : taux de l'économie (gazole, courant, carbone, pièces, voies, centrales)
adminRouter.get("/economy", admin.economySettingsAdmin);
adminRouter.patch("/economy", admin.updateEconomySettingsAdmin);

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

adminRouter.get("/maintenance", admin.maintenanceAdmin);
adminRouter.post("/maintenance", admin.startMaintenance);
adminRouter.delete("/maintenance", admin.endMaintenance);

adminRouter.get("/voters", admin.votersAdmin);
adminRouter.post("/voters/:month/pay", admin.payVoters);
