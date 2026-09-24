import { Request, Response } from "express";
import { prisma } from "../prisma";
import { AuthRequest } from "../middleware/auth.middleware";
import { STATIONS } from "../services/geography.service";
import {
  activeStationEvents,
  upcomingStationEvents,
  competitionMap,
  stationSize,
  stationDemand,
  lineDemand,
  pairKey,
  SIZE_LABEL,
  SHARE_FLOOR,
  SHARE_CEIL,
} from "../services/station.service";

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

/* ============================================================
   Carte vivante du réseau (1.4) : gares, demande, événements, concurrence.

   Gratuit : taille et demande des gares, événements en cours, liaisons
   exploitées par d'autres, et pour chaque ligne sa part de voyageurs.
   Premium : les événements annoncés une heure à l'avance, et le détail de
   chaque concurrent (réputation, rames Express, état des rames) — de quoi
   comprendre pourquoi on perd des voyageurs, et quoi faire.
   ============================================================ */
export async function getNetworkMap(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true, isPremium: true },
  });
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const [events, upcoming, competition, myLines] = await Promise.all([
    activeStationEvents(),
    upcomingStationEvents(),
    competitionMap(),
    prisma.line.findMany({
      where: { companyId: company.id },
      select: { id: true, departureStation: true, arrivalStation: true },
    }),
  ]);

  const stations = STATIONS.map((name) => ({
    name,
    size: stationSize(name),
    sizeLabel: SIZE_LABEL[stationSize(name)],
    demand: Math.round(stationDemand(name, events) * 100) / 100,
    events: events
      .filter((e) => e.station === name)
      .map((e) => ({ label: e.label, multiplier: e.multiplier, endsAt: e.endsAt })),
  }));

  const pairs = [...competition.entries()].map(([key, contenders]) => {
    const [a, b] = key.split("|");
    return {
      a,
      b,
      companies: contenders.length,
      trains: contenders.reduce((s, c) => s + c.trains, 0),
      mine: contenders.some((c) => c.companyId === company.id),
    };
  });

  const lines = (myLines as { id: string; departureStation: string; arrivalStation: string }[]).map((l) => {
    const contenders = competition.get(pairKey(l.departureStation, l.arrivalStation)) ?? [];
    const mine = contenders.find((c) => c.companyId === company.id) ?? null;
    const rivals = contenders.filter((c) => c.companyId !== company.id);
    return {
      lineId: l.id,
      demand: Math.round(lineDemand(l.departureStation, l.arrivalStation, events) * 100) / 100,
      running: Boolean(mine),
      share: mine ? Math.round(mine.share * 1000) / 10 : null,
      multiplier: mine ? Math.round(mine.multiplier * 100) / 100 : null,
      leading: mine ? contenders[0]?.companyId === company.id : null,
      rivals: rivals.map((c) =>
        company.isPremium
          ? {
              name: c.name,
              emblem: c.emblem,
              trains: c.trains,
              share: Math.round(c.share * 1000) / 10,
              reputation: c.reputation,
              expressPct: Math.round(c.express * 100),
              comfortPct: Math.round(c.comfort * 100),
            }
          : { name: c.name, emblem: c.emblem, trains: c.trains, share: Math.round(c.share * 1000) / 10 }
      ),
      // ce que la compagnie vaut elle-même, pour comparer (Premium)
      self:
        company.isPremium && mine
          ? { reputation: mine.reputation, expressPct: Math.round(mine.express * 100), comfortPct: Math.round(mine.comfort * 100), trains: mine.trains }
          : null,
    };
  });

  return res.json({
    isPremium: company.isPremium,
    stations,
    pairs,
    lines,
    upcoming: company.isPremium
      ? upcoming.map((e) => ({ station: e.station, label: e.label, multiplier: e.multiplier, startsAt: e.startsAt, endsAt: e.endsAt }))
      : null,
    // le nombre seul, pour montrer au joueur gratuit qu'il se prépare quelque chose
    upcomingCount: upcoming.length,
    shareBounds: { floor: SHARE_FLOOR, ceil: SHARE_CEIL },
  });
}
