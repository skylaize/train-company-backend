import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma";
import { isAdminEmail, isBanned } from "../services/admin.service";

const JWT_SECRET = process.env.JWT_SECRET as string;

export interface AuthRequest extends Request {
  userId?: string;
  // 2.2 : renseigné par requireAdmin
  admin?: { id: string; name: string; email: string };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token manquant" });
  }

  const token = header.split(" ")[1];

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
    req.userId = payload.userId;
  } catch {
    return res.status(401).json({ error: "Token invalide ou expiré" });
  }

  // 2.2 : compte suspendu depuis le panneau d'administration
  if (isBanned(req.userId)) {
    return res.status(403).json({ error: "Ce compte est suspendu. Contactez l'équipe de Réseau sur Discord.", banned: true });
  }
  next();
}

/* 2.2 : réservé aux adresses de ADMIN_EMAILS. À placer après requireAuth.
   L'adresse est relue en base à chaque appel : un jeton reste valable
   30 jours, il ne doit pas garder des droits retirés entre-temps. */
export async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, email: true, pseudo: true } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: "Accès réservé à l'équipe" });
  }
  req.admin = { id: user.id, name: user.pseudo, email: user.email };
  next();
}
