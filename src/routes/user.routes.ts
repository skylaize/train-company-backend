import { Router } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { isAdminEmail } from "../services/admin.service";

export const userRouter = Router();

userRouter.get("/me", requireAuth, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true, pseudo: true, createdAt: true, company: true, warning: true, warnedAt: true },
  });

  if (!user) {
    return res.status(404).json({ error: "Utilisateur introuvable" });
  }

  // 2.2 : le jeu affiche le lien vers le panneau d'administration
  return res.json({ ...user, isAdmin: isAdminEmail(user.email) });
});

/* Avertissement de l'équipe lu : il ne s'affiche plus. */
userRouter.post("/me/warning/ack", requireAuth, async (req: AuthRequest, res) => {
  await prisma.user.update({ where: { id: req.userId }, data: { warning: null } });
  res.json({ ok: true });
});
