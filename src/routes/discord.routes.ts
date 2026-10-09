import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { discordCallback, discordLinkStart, discordStatus, discordUnlink } from "../controllers/discord.controller";

// 2.1 : liaison du compte Discord (l'endpoint des commandes slash est monté à part, dans server.ts)
export const discordRouter = Router();

discordRouter.get("/discord/status", requireAuth, discordStatus);
discordRouter.post("/discord/link", requireAuth, discordLinkStart);
discordRouter.delete("/discord/link", requireAuth, discordUnlink);
discordRouter.get("/discord/callback", discordCallback);
