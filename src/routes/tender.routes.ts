import { Router } from "express";
import { listTenders, placeBid, withdrawBid } from "../controllers/tender.controller";
import { requireAuth } from "../middleware/auth.middleware";

export const tenderRouter = Router();

tenderRouter.get("/tenders", requireAuth, listTenders);
tenderRouter.post("/tenders/:id/bid", requireAuth, placeBid);
tenderRouter.delete("/tenders/:id/bid", requireAuth, withdrawBid);
