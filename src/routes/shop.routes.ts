import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { getShop, createShopCheckout, getReveals, markRevealed } from "../controllers/shop.controller";

export const shopRouter = Router();

shopRouter.get("/shop", requireAuth, getShop);
shopRouter.post("/shop/checkout", requireAuth, createShopCheckout);
shopRouter.get("/shop/reveals", requireAuth, getReveals);
shopRouter.post("/shop/reveals/seen", requireAuth, markRevealed);
