import { prisma } from "../prisma";
import { routeOf } from "./route.service";
import { passengersPerDeparture, perTrainWaiting, tripLoad, clampPrice, PRICE_ELASTICITY } from "./ridership.service";
import { activeStationEvents, competitionMap, routeDemand, pairKey } from "./station.service";
import { seasonalStationEvents } from "./season.service";
import { peakFactor } from "./peak.service";

/* ============================================================
   Voyageurs d'une ligne (1.7) : ce que la simulation calcule, vu d'avance.
   Sert au tableau des lignes (remplissage, prix conseillé) et au prix
   automatique des abonnés.
   ============================================================ */

export type RidershipLine = {
  id: string;
  departureStation: string;
  arrivalStation: string;
  stops: string[];
  priceRatio: number;
  trains: { model: string; cars: string[]; status: string }[];
};

type Events = Awaited<ReturnType<typeof activeStationEvents>>;
type Competition = Awaited<ReturnType<typeof competitionMap>>;

export function lineRidership(l: RidershipLine, companyId: string, events: Events, competition: Competition) {
  const contenders = competition.get(pairKey(l.departureStation, l.arrivalStation)) ?? [];
  const mine = contenders.find((c) => c.companyId === companyId) ?? null;
  const route = routeOf(l);
  const demand = routeDemand(route, events);
  const share = mine?.multiplier ?? 1;
  const running = l.trains.filter((t) => t.status === "EN_ROUTE");
  const n = Math.max(1, running.length);
  const sample = running.length ? running : [{ model: "STANDARD", cars: [] as string[] }];
  // 1.7 : la demande de l'heure en cours (les couchettes ont leur propre service de nuit)
  const rush = sample.every((t) => t.model === "COUCHETTES") ? 1 : peakFactor();
  const demandNow = demand * rush;
  const perDeparture = passengersPerDeparture(demandNow, route.length - 2, share, l.priceRatio);
  const loads = sample.map((t) => tripLoad(t, perDeparture, n, l.priceRatio));
  const seats = loads.reduce((a, x) => a + x.seats, 0) / loads.length;
  const carried = loads.reduce((a, x) => a + x.passengers, 0) / loads.length;
  const left = loads.reduce((a, x) => a + x.left, 0) / loads.length;
  // prix qui remplirait juste les rames : au-delà on perd des voyageurs, en deçà on laisse de l'argent
  const atNormal = perTrainWaiting(passengersPerDeparture(demandNow, route.length - 2, share, 1), n);
  const idealPrice = clampPrice(Math.pow(atNormal / Math.max(1, seats), 1 / PRICE_ELASTICITY));
  return {
    demand,
    mine,
    contenders,
    ridership: {
      perDeparture: Math.round(perDeparture),
      seats: Math.round(seats),
      carried: Math.round(carried),
      left: Math.round(left),
      fill: Math.round((carried / Math.max(1, seats)) * 100),
      trains: running.length,
      price: l.priceRatio,
      idealPrice,
      estimated: running.length === 0,
    },
  };
}

/* Premium : chaque heure, les lignes en prix automatique se calent sur le prix conseillé. */
export async function runAutoPricing() {
  const lines = (await prisma.line.findMany({
    where: { autoPrice: true, company: { isPremium: true } },
    select: {
      id: true, companyId: true, departureStation: true, arrivalStation: true, stops: true, priceRatio: true,
      trains: { select: { model: true, cars: true, status: true } },
    },
  })) as (RidershipLine & { companyId: string })[];
  if (lines.length === 0) return 0;
  const [live, competition] = await Promise.all([activeStationEvents(), competitionMap()]);
  const events = [...live, ...seasonalStationEvents()];
  let changed = 0;
  for (const l of lines) {
    const { ridership } = lineRidership(l, l.companyId, events, competition);
    if (Math.abs(ridership.idealPrice - l.priceRatio) >= 0.05) {
      await prisma.line.update({ where: { id: l.id }, data: { priceRatio: ridership.idealPrice } });
      changed++;
    }
  }
  return changed;
}
