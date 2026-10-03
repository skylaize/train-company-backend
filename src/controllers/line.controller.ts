import { lineRidership, RidershipLine } from "../services/pricing.service";
import { activeStationEvents, competitionMap } from "../services/station.service";
import { seasonalStationEvents } from "../services/season.service";
import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { isKnownStation } from "../services/geography.service";
import { isInternational } from "../services/international.service";
import { cleanStops, routeDuration } from "../services/route.service";
import { clampPrice } from "../services/ridership.service";
import { NIGHT_MIN_DURATION } from "./train.controller";

/* 1.6 : une gare à l'étranger demande la licence internationale (1.7 : arrêts compris). */
function licenceError(company: { intlLicenceAt?: Date | null }, route: string[]) {
  if (!route.some(isInternational) || company.intlLicenceAt) return null;
  return "Cette ligne passe la frontière : il faut d'abord la licence internationale (page Lignes)";
}

async function getOwnedCompanyOrFail(userId: string) {
  return prisma.company.findUnique({ where: { ownerId: userId } });
}

export async function createLine(req: AuthRequest, res: Response) {
  const { departureStation, arrivalStation } = req.body;

  if (!departureStation || !arrivalStation) {
    return res.status(400).json({
      error: "departureStation et arrivalStation sont requis",
    });
  }
  // 1.6 : le nom est facultatif, la ligne prend celui de ses deux gares
  const name = (typeof req.body.name === "string" && req.body.name.trim().slice(0, 60)) || `${departureStation} — ${arrivalStation}`;

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

  const cleaned = cleanStops(req.body.stops, departureStation, arrivalStation);
  if ("error" in cleaned) return res.status(400).json({ error: cleaned.error });
  const route = [departureStation, ...cleaned.stops, arrivalStation];

  const noLicence = licenceError(company as { intlLicenceAt?: Date | null }, route);
  if (noLicence) return res.status(403).json({ error: noLicence });

  /* La durée vient de la distance, jamais du client : le rendement croît avec
     la longueur, donc une durée déclarée serait une prime gratuite.
     1.7 : somme des tronçons, plus une minute par arrêt. */
  const durationMinutes = routeDuration(route);

  const line = await prisma.line.create({
    data: {
      name,
      departureStation,
      arrivalStation,
      stops: cleaned.stops,
      priceRatio: req.body.priceRatio !== undefined ? clampPrice(req.body.priceRatio) : 1,
      durationMinutes,
      companyId: company.id,
    },
  });

  return res.status(201).json(line);
}

export async function updateLine(req: AuthRequest, res: Response) {
  const { lineId, name, departureStation, arrivalStation, priceRatio } = req.body;

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

  /* 1.7 — Premium : prix automatique. Seul changement de la requête : on ne
     touche pas au reste de la ligne. */
  if (req.body.autoPrice !== undefined && departureStation === undefined && arrivalStation === undefined && req.body.stops === undefined) {
    if (req.body.autoPrice && !(company as { isPremium?: boolean }).isPremium) {
      return res.status(403).json({ error: "Le prix automatique est réservé aux abonnés Premium" });
    }
    const on = Boolean(req.body.autoPrice);
    let priceNow: number | undefined;
    if (on) {
      // le prix conseillé s'applique tout de suite, puis chaque heure
      const full = (await prisma.line.findUnique({
        where: { id: lineId },
        select: { id: true, departureStation: true, arrivalStation: true, stops: true, priceRatio: true, trains: { select: { model: true, cars: true, status: true } } },
      })) as RidershipLine;
      const [live, competition] = await Promise.all([activeStationEvents(), competitionMap()]);
      priceNow = lineRidership(full, company.id, [...live, ...seasonalStationEvents()], competition).ridership.idealPrice;
    }
    const updated = await prisma.line.update({ where: { id: lineId }, data: { autoPrice: on, ...(priceNow !== undefined ? { priceRatio: priceNow } : {}) } });
    return res.json(updated);
  }

  const nextDeparture = departureStation ?? line.departureStation;
  const nextArrival = arrivalStation ?? line.arrivalStation;

  if (nextDeparture === nextArrival) {
    return res.status(400).json({ error: "Les deux gares doivent être différentes" });
  }
  if (!isKnownStation(nextDeparture) || !isKnownStation(nextArrival)) {
    return res.status(400).json({ error: "Gare inconnue du réseau" });
  }

  // arrêts : absents de la requête = inchangés ; une liste (même vide) les remplace
  const currentStops = ((line as { stops?: string[] }).stops ?? []).filter((s) => s !== nextDeparture && s !== nextArrival);
  const cleaned = cleanStops(req.body.stops !== undefined ? req.body.stops : currentStops, nextDeparture, nextArrival);
  if ("error" in cleaned) return res.status(400).json({ error: cleaned.error });
  const route = [nextDeparture, ...cleaned.stops, nextArrival];
  const before = [line.departureStation, ...((line as { stops?: string[] }).stops ?? []), line.arrivalStation];
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const routeChanged = !same(route, before) && !same(route, [...before].reverse());

  const noLicence = licenceError(company as { intlLicenceAt?: Date | null }, route);
  if (noLicence) return res.status(403).json({ error: noLicence });

  // recalcul systématique : sinon on contournerait la règle par une modification
  const nextDuration = routeDuration(route);

  /* une rame couchettes ne peut pas rester sur une ligne devenue trop courte */
  const couchettes = await prisma.train.count({ where: { lineId, model: "COUCHETTES" } });
  if (couchettes > 0 && nextDuration < NIGHT_MIN_DURATION) {
    return res.status(409).json({ error: `Une rame couchettes roule sur cette ligne : elle doit garder au moins ${NIGHT_MIN_DURATION} min de trajet` });
  }

  const updated = await prisma.line.update({
    where: { id: lineId },
    data: {
      ...(name !== undefined ? { name: String(name).trim().slice(0, 60) || `${nextDeparture} — ${nextArrival}` } : {}),
      departureStation: nextDeparture,
      arrivalStation: nextArrival,
      stops: cleaned.stops,
      durationMinutes: nextDuration,
      // 1.7 : changer les gares, c'est poser d'autres voies — l'électrification est perdue
      ...(routeChanged ? { electrified: false } : {}),
      // un prix posé à la main reprend la main sur le prix automatique
      ...(priceRatio !== undefined ? { priceRatio: clampPrice(priceRatio), autoPrice: false } : {}),
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

  // ordre stable : c'est aussi lui qui donne sa couleur à chaque ligne sur la carte
  const lines = await prisma.line.findMany({
    where: { companyId: company.id },
    include: { trains: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  return res.json(lines);
}

/* 1.7 — Premium : remplissage de la ligne heure par heure sur 24 h. */
export async function getLineLoad(req: AuthRequest, res: Response) {
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  if (!(company as { isPremium?: boolean }).isPremium) return res.status(403).json({ error: "Réservé aux abonnés Premium" });
  const line = await prisma.line.findFirst({ where: { id: String(req.params.id), companyId: company.id } });
  if (!line) return res.status(404).json({ error: "Ligne introuvable" });
  const now = Math.floor(Date.now() / 3600_000) * 3600_000;
  const rows = (await prisma.lineLoadHour.findMany({
    where: { lineId: line.id, hour: { gte: new Date(now - 23 * 3600_000) } },
  })) as { hour: Date; trips: number; passengers: number; seats: number; left: number }[];
  const byHour = new Map(rows.map((r) => [new Date(r.hour).getTime(), r]));
  const hours = Array.from({ length: 24 }, (_, i) => {
    const at = now - (23 - i) * 3600_000;
    const r = byHour.get(at);
    return {
      hour: new Date(at),
      trips: r?.trips ?? 0,
      passengers: r?.passengers ?? 0,
      left: r?.left ?? 0,
      fill: r && r.seats ? Math.round((r.passengers / r.seats) * 100) : null,
    };
  });
  const withTrips = hours.filter((h) => h.trips > 0);
  const peak = withTrips.length ? withTrips.reduce((a, b) => (b.passengers + b.left > a.passengers + a.left ? b : a)) : null;
  return res.json({
    hours,
    totals: {
      trips: withTrips.reduce((a, h) => a + h.trips, 0),
      passengers: withTrips.reduce((a, h) => a + h.passengers, 0),
      left: withTrips.reduce((a, h) => a + h.left, 0),
    },
    peak: peak ? peak.hour : null,
  });
}
