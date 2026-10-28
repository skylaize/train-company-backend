import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

export async function listMyIncidents(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  /* 2.4.1 : les rames d'abord, puis leurs incidents. Avec « include: { train } »,
     Prisma lit les incidents puis les rames en deux temps : une rame vendue ou
     mise à la casse entre les deux faisait échouer la requête
     (« Field train is required to return data, got null »). */
  const trains = await prisma.train.findMany({ where: { companyId: company.id } });
  const byId = new Map(trains.map((t) => [t.id, t]));
  const incidents = byId.size
    ? await prisma.incident.findMany({
        where: { trainId: { in: [...byId.keys()] } },
        orderBy: { createdAt: "desc" },
        take: 10,
      })
    : [];

  return res.json(incidents.map((i) => ({ ...i, train: byId.get(i.trainId) })).filter((i) => i.train));
}
