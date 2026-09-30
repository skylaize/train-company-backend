import { Router } from "express";
import { register, login, providers, oauthStart, oauthCallback, forgotPassword, resetPassword } from "../controllers/auth.controller";

export const authRouter = Router();

authRouter.post("/register", register);
authRouter.post("/login", login);
// 1.6 : ce que l'écran de connexion peut proposer (Discord, Google, Turnstile, mot de passe oublié)
authRouter.get("/providers", providers);
authRouter.get("/oauth/:provider", oauthStart);
authRouter.get("/oauth/:provider/callback", oauthCallback);
authRouter.post("/forgot", forgotPassword);
authRouter.post("/reset", resetPassword);
