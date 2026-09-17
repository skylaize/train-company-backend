import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

export async function getLeaderboard(req: AuthRequest, res: Response) {
  const companies = await prisma.company.findMany({
    orderBy: { balance: "desc" },
    take: 20,
    select: {
      id: true,
      name: true,
      liveryColor: true,
      balance: true,
      _count: { select: { trains: true, lines: true } },
    },
  });

  const me = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });

  return res.json({
    companies,
    myCompanyId: me?.id ?? null,
  });
}
