import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

async function getOwnedCompanyOrFail(userId: string) {
  return prisma.company.findUnique({ where: { ownerId: userId } });
}

export async function createLine(req: AuthRequest, res: Response) {
  const { name, departureStation, arrivalStation, durationMinutes } = req.body;

  if (!name || !departureStation || !arrivalStation || !durationMinutes) {
    return res.status(400).json({
      error: "name, departureStation, arrivalStation et durationMinutes sont requis",
    });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const line = await prisma.line.create({
    data: {
      name,
      departureStation,
      arrivalStation,
      durationMinutes,
      companyId: company.id,
    },
  });

  return res.status(201).json(line);
}

export async function updateLine(req: AuthRequest, res: Response) {
  const { lineId, name, departureStation, arrivalStation, durationMinutes } = req.body;

  if (!lineId) {
    return res.status(400).json({ error: "lineId est requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const line = await prisma.line.findFirst({ where: { id: lineId, companyId: company.id } });
  if (!line) {
    return res.status(404).json({ error: "Ligne introuvable" });
  }

  const updated = await prisma.line.update({
    where: { id: lineId },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(departureStation !== undefined ? { departureStation } : {}),
      ...(arrivalStation !== undefined ? { arrivalStation } : {}),
      ...(durationMinutes !== undefined ? { durationMinutes: Number(durationMinutes) } : {}),
    },
  });

  return res.json(updated);
}

export async function deleteLine(req: AuthRequest, res: Response) {
  const { lineId } = req.body;

  if (!lineId) {
    return res.status(400).json({ error: "lineId est requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const line = await prisma.line.findFirst({ where: { id: lineId, companyId: company.id } });
  if (!line) {
    return res.status(404).json({ error: "Ligne introuvable" });
  }

  // les trains affectés à cette ligne sont libérés avant suppression (sans perdre
  // leur statut "en panne" si c'était le cas, pour ne pas les faire passer inaperçus)
  await prisma.$transaction([
    prisma.train.updateMany({
      where: { lineId, status: { not: "MAINTENANCE" } },
      data: { lineId: null, status: "IDLE", progress: 0, departedAt: null },
    }),
    prisma.train.updateMany({
      where: { lineId, status: "MAINTENANCE" },
      data: { lineId: null, progress: 0, departedAt: null },
    }),
    prisma.line.delete({ where: { id: lineId } }),
  ]);

  return res.json({ success: true });
}

export async function listMyLines(req: AuthRequest, res: Response) {
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const lines = await prisma.line.findMany({
    where: { companyId: company.id },
    include: { trains: true },
  });

  return res.json(lines);
}
