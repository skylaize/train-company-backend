import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

export async function listMyTransactions(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const transactions = await prisma.transaction.findMany({
    where: { companyId: company.id },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  return res.json(transactions);
}
