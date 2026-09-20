import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import {
  getMarketPrices,
  buyCargo,
  sellCargo,
  listAlerts,
  createAlert,
  deleteAlert,
  acknowledgeAlerts,
  createStandingOrder,
  deleteStandingOrder,
} from "../controllers/market.controller";

export const marketRouter = Router();

marketRouter.get("/market/prices", requireAuth, getMarketPrices);
marketRouter.post("/market/buy", requireAuth, buyCargo);
marketRouter.post("/market/sell", requireAuth, sellCargo);

marketRouter.get("/market/alerts", requireAuth, listAlerts);
marketRouter.post("/market/alerts", requireAuth, createAlert);
marketRouter.post("/market/alerts/seen", requireAuth, acknowledgeAlerts);
marketRouter.delete("/market/alerts/:id", requireAuth, deleteAlert);

marketRouter.post("/market/orders", requireAuth, createStandingOrder);
marketRouter.delete("/market/orders/:id", requireAuth, deleteStandingOrder);
