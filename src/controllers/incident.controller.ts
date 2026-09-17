import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

export async function listMyIncidents(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const incidents = await prisma.incident.findMany({
    where: { train: { companyId: company.id } },
    include: { train: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return res.json(incidents);
}
