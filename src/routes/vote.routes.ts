import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { claimVote, getMyVote } from "../controllers/vote.controller";

// 2.6.1 : vote Top-Serveurs
export const voteRouter = Router();

voteRouter.get("/vote/mine", requireAuth, getMyVote);
voteRouter.post("/vote/claim", requireAuth, claimVote);
