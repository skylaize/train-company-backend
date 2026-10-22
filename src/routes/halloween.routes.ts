import { Router } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { halloweenView } from "../services/halloween.service";

/* 2.2 : Halloween — la hantise en cours, l'horaire à venir, mes âmes, le classement */
export const halloweenRouter = Router();

halloweenRouter.get("/halloween", requireAuth, async (req: AuthRequest, res) => {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true } });
  res.json(await halloweenView(company?.id ?? null));
});
