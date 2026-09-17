import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { changePassword, deleteAccount } from "../controllers/account.controller";

export const accountRouter = Router();

accountRouter.post("/account/change-password", requireAuth, changePassword);
accountRouter.delete("/account", requireAuth, deleteAccount);
