import { Request, Response } from "express";
import { prisma } from "../prisma";

export async function getNetworkStats(_req: Request, res: Response) {
  const [activeCompanies, trainsInService, goodTrips, totalIncidents, recentIncidents] = await Promise.all([
    prisma.company.count(),
    prisma.train.count({ where: { status: "EN_ROUTE" } }),
    prisma.transaction.count({ where: { type: "REVENU_LIGNE" } }),
    prisma.incident.count(),
    prisma.incident.count({ where: { createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } }),
  ]);

  const totalOps = goodTrips + totalIncidents;
  const punctuality = totalOps === 0 ? 100 : Math.round((goodTrips / totalOps) * 100);

  return res.json({
    activeCompanies,
    trainsInService,
    punctuality,
    activeIncidents: recentIncidents,
  });
}
