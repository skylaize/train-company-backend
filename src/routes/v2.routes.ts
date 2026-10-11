import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import {
  getSeason, getWorld, getAlliance, createAlliance, inviteToAlliance, answerInvite, leaveAlliance, kickMember, updateAlliance, postMessage, deleteMessage, applyToAlliance, withdrawApplication, answerApplication, getGazette, getDlcs, getPass, claimPass,
} from "../controllers/v2.controller";
import { getWrecks, postBuyWreck, postRestore, postCommission } from "../controllers/wreck.controller";

// 2.0 : saisons, alliances, Grand Chantier
export const v2Router = Router();

v2Router.get("/season", requireAuth, getSeason);
v2Router.get("/world", requireAuth, getWorld);
v2Router.get("/alliance", requireAuth, getAlliance);
v2Router.post("/alliance", requireAuth, createAlliance);
v2Router.patch("/alliance", requireAuth, updateAlliance);
v2Router.post("/alliance/invite", requireAuth, inviteToAlliance);
v2Router.post("/alliance/invites/:id", requireAuth, answerInvite);
v2Router.post("/alliance/leave", requireAuth, leaveAlliance);
v2Router.post("/alliance/kick", requireAuth, kickMember);
// 2.0.2 : candidatures
v2Router.post("/alliances/:id/apply", requireAuth, applyToAlliance);
v2Router.delete("/alliance/applications/:id", requireAuth, withdrawApplication);
v2Router.post("/alliance/applications/:id", requireAuth, answerApplication);
v2Router.post("/alliance/messages", requireAuth, postMessage);
v2Router.delete("/alliance/messages/:id", requireAuth, deleteMessage);
v2Router.get("/gazette", requireAuth, getGazette);
v2Router.get("/dlc", requireAuth, getDlcs);
v2Router.get("/season/pass", requireAuth, getPass);
v2Router.post("/season/pass/claim", requireAuth, claimPass);
// 2.0 : les épaves
v2Router.get("/wrecks", requireAuth, getWrecks);
v2Router.post("/wrecks/:id/buy", requireAuth, postBuyWreck);
v2Router.post("/wrecks/:id/restore", requireAuth, postRestore);
v2Router.post("/wrecks/:id/commission", requireAuth, postCommission);
