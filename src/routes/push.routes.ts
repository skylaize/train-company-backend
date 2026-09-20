import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import {
  getPushKey,
  subscribePush,
  unsubscribePush,
  testPush,
  listPushSubscriptions,
} from "../controllers/push.controller";

export const pushRouter = Router();

pushRouter.get("/push/key", requireAuth, getPushKey);
pushRouter.get("/push/mine", requireAuth, listPushSubscriptions);
pushRouter.post("/push/subscribe", requireAuth, subscribePush);
pushRouter.post("/push/unsubscribe", requireAuth, unsubscribePush);
pushRouter.post("/push/test", requireAuth, testPush);
