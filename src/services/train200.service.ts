import { prisma } from "../prisma";
import { STATION_COORDS } from "./geography.service";

/* ============================================================
   2.1.2 : le Train des 200.

   Pour fêter les 200 compagnies, un train spécial fait le tour de France en
   48 heures, par toutes les gares que le réseau dessert. Son trajet est
   tracé une fois, au départ, et ne bouge plus : chaque joueur peut voir à
   quelle heure il passera chez lui.

   Quand il entre dans une gare, chaque compagnie qui la dessert touche une
   prime (une seule fois pendant tout le voyage) et son nom est peint sur
   ses voitures. Le départ se règle avec TRAIN200_START (date ISO) ; sans
   elle, le train part au premier tour de simulation après le déploiement.
   ============================================================ */

export const TRAIN200_ID = "train-200";
export const TRAIN200_DURATION_MS = 48 * 3_600_000;
export const TRAIN200_REWARD = 250;

export interface Stop {
  station: string;
  at: string;
}

type Notify = (companyId: string, title: string, body: string) => Promise<void>;

function dist(a: string, b: string) {
  const p = STATION_COORDS[a], q = STATION_COORDS[b];
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/* toutes les gares desservies, en une tournée : la plus proche à chaque
   fois, au départ de Paris (ou de la gare la plus au nord s'il n'y en a pas),
   puis un passage pour décroiser la tournée */
export function planRoute(stations: string[], start: Date, durationMs = TRAIN200_DURATION_MS): Stop[] {
  const left = [...new Set(stations)].filter((s) => STATION_COORDS[s]);
  if (left.length === 0) return [];
  const first = left.includes("Paris") ? "Paris" : [...left].sort((a, b) => STATION_COORDS[a].y - STATION_COORDS[b].y)[0];
  const tour = [first];
  left.splice(left.indexOf(first), 1);
  while (left.length) {
    const here = tour[tour.length - 1];
    let best = 0;
    for (let i = 1; i < left.length; i++) if (dist(here, left[i]) < dist(here, left[best])) best = i;
    tour.push(left.splice(best, 1)[0]);
  }
  // 2-opt : on retourne un tronçon tant que ça raccourcit le trajet
  for (let improved = true, guard = 0; improved && guard < 50; guard++) {
    improved = false;
    for (let i = 1; i < tour.length - 2; i++) {
      for (let j = i + 1; j < tour.length - 1; j++) {
        const before = dist(tour[i - 1], tour[i]) + dist(tour[j], tour[j + 1]);
        const after = dist(tour[i - 1], tour[j]) + dist(tour[i], tour[j + 1]);
        if (after < before - 0.01) {
          tour.splice(i, j - i + 1, ...tour.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    }
  }
  // l'horaire : le temps entre deux gares suit la distance
  const legs = tour.slice(1).map((s, i) => dist(tour[i], s));
  const total = legs.reduce((a, b) => a + b, 0) || 1;
  let t = start.getTime();
  return tour.map((station, i) => {
    if (i > 0) t += (legs[i - 1] / total) * durationMs;
    return { station, at: new Date(i === tour.length - 1 ? start.getTime() + durationMs : t).toISOString() };
  });
}

async function servedStations() {
  const lines = await prisma.line.findMany({ select: { departureStation: true, arrivalStation: true, stops: true } });
  return lines.flatMap((l) => [l.departureStation, ...(l.stops ?? []), l.arrivalStation]);
}

/* le train existe dès que son heure de départ approche ; il n'est tracé qu'une fois */
export async function ensureTrain200() {
  const existing = await prisma.specialTrain.findUnique({ where: { id: TRAIN200_ID } });
  if (existing) return existing;
  const fromEnv = process.env.TRAIN200_START ? new Date(process.env.TRAIN200_START) : null;
  const start = fromEnv && !Number.isNaN(fromEnv.getTime()) ? fromEnv : new Date();
  // on attend la dernière heure avant le départ pour tracer le trajet : il compte les lignes du moment
  if (start.getTime() - Date.now() > 3_600_000) return null;
  const route = planRoute(await servedStations(), start);
  if (route.length < 2) return null;
  try {
    return await prisma.specialTrain.create({
      data: { id: TRAIN200_ID, startsAt: start, endsAt: new Date(start.getTime() + TRAIN200_DURATION_MS), route: route as unknown as object },
    });
  } catch {
    // un autre serveur vient de le créer
    return prisma.specialTrain.findUnique({ where: { id: TRAIN200_ID } });
  }
}

/* à chaque tour : les gares atteintes depuis le tour précédent */
export async function runTrain200(notify: Notify) {
  const train = await ensureTrain200();
  if (!train) return;
  const route = train.route as unknown as Stop[];
  const now = Date.now();
  let reached = -1;
  for (let i = 0; i < route.length; i++) if (new Date(route[i].at).getTime() <= now) reached = i;
  if (reached <= train.lastStop) return;

  for (let i = train.lastStop + 1; i <= reached; i++) {
    const station = route[i].station;
    const lines: { companyId: string }[] = await prisma.line.findMany({
      where: { OR: [{ departureStation: station }, { arrivalStation: station }, { stops: { has: station } }] },
      select: { companyId: true },
    });
    const companies = [...new Set(lines.map((l) => l.companyId))];
    for (const companyId of companies) {
      try {
        await prisma.specialTrainVisit.create({ data: { trainId: TRAIN200_ID, companyId, station, reward: TRAIN200_REWARD } });
      } catch {
        continue; // déjà visitée plus tôt dans le voyage : une prime par compagnie
      }
      await prisma.$transaction([
        prisma.company.update({ where: { id: companyId }, data: { balance: { increment: TRAIN200_REWARD } } }),
        prisma.transaction.create({
          data: { companyId, type: "TRAIN_200", amount: TRAIN200_REWARD, description: `Le Train des 200 est passé à ${station}` },
        }),
      ]);
      await notify(
        companyId,
        "Le Train des 200 est passé chez vous",
        `En gare de ${station} : +${TRAIN200_REWARD} pi., et le nom de votre compagnie est peint sur ses voitures.`
      ).catch(() => undefined);
    }
    // on avance gare par gare : un tour interrompu reprend où il s'était arrêté
    await prisma.specialTrain.update({ where: { id: TRAIN200_ID }, data: { lastStop: i } });
  }
}
