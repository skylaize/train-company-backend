import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { durationBetween, isKnownStation } from "../services/geography.service";

async function getOwnedCompanyOrFail(userId: string) {
  return prisma.company.findUnique({ where: { ownerId: userId } });
}

export async function createLine(req: AuthRequest, res: Response) {
  const { name, departureStation, arrivalStation } = req.body;

  if (!name || !departureStation || !arrivalStation) {
    return res.status(400).json({
      error: "name, departureStation et arrivalStation sont requis",
    });
  }

  if (departureStation === arrivalStation) {
    return res.status(400).json({ error: "Les deux gares doivent être différentes" });
  }

  if (!isKnownStation(departureStation) || !isKnownStation(arrivalStation)) {
    return res.status(400).json({ error: "Gare inconnue du réseau" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  /* La durée vient de la distance, jamais du client : le rendement croît avec
     la longueur, donc une durée déclarée serait une prime gratuite. */
  const durationMinutes = durationBetween(departureStation, arrivalStation) as number;

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
  const { lineId, name, departureStation, arrivalStation } = req.body;

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

  const nextDeparture = departureStation ?? line.departureStation;
  const nextArrival = arrivalStation ?? line.arrivalStation;

  if (nextDeparture === nextArrival) {
    return res.status(400).json({ error: "Les deux gares doivent être différentes" });
  }
  if (!isKnownStation(nextDeparture) || !isKnownStation(nextArrival)) {
    return res.status(400).json({ error: "Gare inconnue du réseau" });
  }

  // recalcul systématique : sinon on contournerait la règle par une modification
  const nextDuration = durationBetween(nextDeparture, nextArrival) as number;

  const updated = await prisma.line.update({
    where: { id: lineId },
    data: {
      ...(name !== undefined ? { name } : {}),
      departureStation: nextDeparture,
      arrivalStation: nextArrival,
      durationMinutes: nextDuration,
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
