import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

function startOfToday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function getTodaySummary(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const since = startOfToday();

  const [transactionsToday, incidentsToday] = await Promise.all([
    prisma.transaction.findMany({ where: { companyId: company.id, createdAt: { gte: since } } }),
    prisma.incident.count({ where: { train: { companyId: company.id }, createdAt: { gte: since } } }),
  ]);

  const income = transactionsToday.filter((t) => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
  const expenses = transactionsToday.filter((t) => t.amount < 0).reduce((sum, t) => sum + t.amount, 0);
  const lineTrips = transactionsToday.filter((t) => t.type === "REVENU_LIGNE").length;
  const freightDeliveries = transactionsToday.filter((t) => t.type === "FRET").length;

  return res.json({
    income,
    expenses,
    net: income + expenses,
    lineTrips,
    freightDeliveries,
    incidents: incidentsToday,
  });
}
