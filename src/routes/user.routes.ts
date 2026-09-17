import { Router } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

export const userRouter = Router();

userRouter.get("/me", requireAuth, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true, pseudo: true, createdAt: true, company: true },
  });

  if (!user) {
    return res.status(404).json({ error: "Utilisateur introuvable" });
  }

  return res.json(user);
});
