import { Router } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { isAdminEmail } from "../services/admin.service";

export const userRouter = Router();

userRouter.get("/me", requireAuth, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true, pseudo: true, createdAt: true, company: true },
  });

  if (!user) {
    return res.status(404).json({ error: "Utilisateur introuvable" });
  }

  // 2.2 : le jeu affiche le lien vers le panneau d'administration
  return res.json({ ...user, isAdmin: isAdminEmail(user.email) });
});
