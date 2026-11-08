import { Router } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { reputationDetail } from "../services/reputation.service";
import { createCompany, getMyCompany, updateCompany, expandFleet, buyLicence, claimTutorialReward } from "../controllers/company.controller";

export const companyRouter = Router();

companyRouter.post("/company", requireAuth, createCompany);
companyRouter.get("/company", requireAuth, getMyCompany);
companyRouter.patch("/company", requireAuth, updateCompany);
companyRouter.post("/company/expand-fleet", requireAuth, expandFleet);
companyRouter.post("/company/licence", requireAuth, buyLicence);
companyRouter.post("/company/tutorial-reward", requireAuth, claimTutorialReward);

/* D'où vient la note de réputation : lu à l'ouverture de la fenêtre seulement. */
companyRouter.get("/company/reputation", requireAuth, async (req: AuthRequest, res) => {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId }, select: { id: true } });
  if (!company) return res.status(404).json({ error: "Compagnie introuvable" });
  res.json(await reputationDetail(company.id));
});
