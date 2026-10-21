import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { Stop, TRAIN200_ID, TRAIN200_REWARD } from "../services/train200.service";

/* 2.1.2 : le Train des 200, vu du joueur — son trajet et son horaire, les
   noms déjà peints sur ses voitures, et quand il passe chez soi. */
export async function getTrain200(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true, lines: { select: { departureStation: true, arrivalStation: true, stops: true } } },
  });
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const train = await prisma.specialTrain.findUnique({ where: { id: TRAIN200_ID } });
  if (!train) return res.json({ exists: false });

  const route = train.route as unknown as Stop[];
  const visits = await prisma.specialTrainVisit.findMany({ where: { trainId: TRAIN200_ID }, orderBy: { at: "asc" } });
  const names = await prisma.company.findMany({
    where: { id: { in: visits.map((v) => v.companyId) } },
    select: { id: true, name: true, liveryColor: true },
  });
  const byId = new Map(names.map((c) => [c.id, c]));
  const mine = visits.find((v) => v.companyId === company.id) ?? null;

  // la prochaine gare du trajet que la compagnie dessert
  const myStations = new Set(company.lines.flatMap((l) => [l.departureStation, ...(l.stops ?? []), l.arrivalStation]));
  const now = Date.now();
  const nextForMe = mine ? null : route.find((s) => myStations.has(s.station) && new Date(s.at).getTime() > now) ?? null;

  return res.json({
    exists: true,
    startsAt: train.startsAt,
    endsAt: train.endsAt,
    reward: TRAIN200_REWARD,
    route,
    painted: visits
      .map((v) => ({ name: byId.get(v.companyId)?.name ?? "", livery: byId.get(v.companyId)?.liveryColor ?? "#c99a3e", station: v.station, at: v.at }))
      .filter((p) => p.name),
    mine: mine ? { station: mine.station, at: mine.at, reward: mine.reward } : null,
    nextForMe,
  });
}
