/* ============================================================
   Exploitation voyageurs (1.7) : capacité, remplissage, prix du billet,
   composition des rames, arrêts intermédiaires.

   Avant la 1.7, chaque trajet rapportait « 8 pi. par minute » quelle que
   soit la foule sur le quai : aligner dix rames sur la même liaison
   multipliait la recette par dix. Désormais une liaison attire un nombre
   de voyageurs (sa demande), chaque rame offre des places, et la recette
   suit les voyageurs réellement transportés. Une rame seule sur une ligne
   ordinaire roule pleine et rapporte comme avant ; au-delà de ce que la
   liaison attire, les rames supplémentaires roulent à moitié vides.

   Les mêmes calculs servent à la simulation et aux estimations affichées :
   le client en garde une copie dans src/economy.ts (côté site).
   ============================================================ */

import { durationFromKm, distanceKm } from "./geography.service";

/* ---------- voitures et composition ---------- */

export type CarType = "SECONDE" | "PREMIERE" | "BAR" | "COUCHETTE";

export const CAR_TYPES: Record<CarType, { label: string; seats: number; fare: number; cost: number; max?: number; couchettesOnly?: boolean; bonus?: number }> = {
  SECONDE: { label: "Voiture 2e classe", seats: 60, fare: 1, cost: 60 },
  PREMIERE: { label: "Voiture 1re classe", seats: 36, fare: 1.8, cost: 120 },
  // pas de places, mais tout le train rapporte un peu plus et attire davantage
  BAR: { label: "Voiture-bar", seats: 0, fare: 1, cost: 150, max: 1, bonus: 0.08 },
  COUCHETTE: { label: "Voiture-couchettes", seats: 30, fare: 1, cost: 90, couchettesOnly: true },
};

export const MODEL_CARS: Record<string, { base: CarType[]; max: number }> = {
  STANDARD: { base: ["SECONDE", "SECONDE", "SECONDE", "SECONDE"], max: 6 },
  EXPRESS: { base: ["SECONDE", "SECONDE", "SECONDE", "SECONDE", "PREMIERE"], max: 8 },
  // une locomotive de fret tire peu de voyageurs : son métier, ce sont les marchandises
  FRET_LOURD: { base: ["SECONDE", "SECONDE"], max: 3 },
  COUCHETTES: { base: ["COUCHETTE", "COUCHETTE", "COUCHETTE", "COUCHETTE", "COUCHETTE", "COUCHETTE", "COUCHETTE", "COUCHETTE"], max: 10 },
};

export function parseCars(model: string, cars: string | null | undefined): CarType[] {
  if (!cars) return [...(MODEL_CARS[model]?.base ?? MODEL_CARS.STANDARD.base)];
  return cars.split(",").filter((c): c is CarType => c in CAR_TYPES);
}

export function carsValid(model: string, cars: CarType[]): string | null {
  const def = MODEL_CARS[model] ?? MODEL_CARS.STANDARD;
  if (cars.length < 1) return "Une rame garde au moins une voiture";
  if (cars.length > def.max) return `Cette rame tire ${def.max} voitures au plus`;
  for (const t of Object.keys(CAR_TYPES) as CarType[]) {
    const n = cars.filter((c) => c === t).length;
    const spec = CAR_TYPES[t];
    if (spec.max !== undefined && n > spec.max) return `${spec.max} ${spec.label.toLowerCase()} au plus`;
    if (n > 0 && spec.couchettesOnly && model !== "COUCHETTES") return "Les voitures-couchettes vont sur une rame couchettes";
    if (n > 0 && !spec.couchettesOnly && t !== "BAR" && model === "COUCHETTES") return "Une rame couchettes ne tire que des voitures-couchettes et une voiture-bar";
  }
  return null;
}

export interface Capacity {
  seats: number; // places réelles
  seatsEq: number; // places pondérées par le tarif (une place de 1re vaut 1,8)
  bonus: number; // voiture-bar
  extraCars: number; // voitures au-delà de la composition d'origine (usure)
}

export function capacityOf(model: string, cars: string | null | undefined): Capacity {
  const list = parseCars(model, cars);
  const base = MODEL_CARS[model]?.base.length ?? 4;
  return {
    seats: list.reduce((s, c) => s + CAR_TYPES[c].seats, 0),
    seatsEq: list.reduce((s, c) => s + CAR_TYPES[c].seats * CAR_TYPES[c].fare, 0),
    bonus: list.reduce((s, c) => s + (CAR_TYPES[c].bonus ?? 0), 0),
    extraCars: Math.max(0, list.length - base),
  };
}

// une voiture de plus que prévu use un peu plus la rame
export const WEAR_PER_EXTRA_CAR = 0.06;

/* ---------- tarif ---------- */

export const FARE_MIN = 0.6;
export const FARE_MAX = 1.6;
// recette par voyageur et par minute de trajet, au tarif normal : 240 places pleines = 8 pi./min comme avant
export const FARE_PER_PAX_MIN = 8 / 240;
/* Élasticité : +10 % sur le prix fait perdre environ 15 % de voyageurs.
   Une rame seule sur une liaison qui attire plus qu'elle ne transporte
   gagne à monter un peu ses prix (jusqu'à remplir juste ses places) ;
   au-delà, elle roule à moitié vide. Le bon prix dépend donc de la ligne. */
export const PRICE_ELASTICITY = 1.6;

export function clampFare(f: unknown) {
  const n = Number(f);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(FARE_MAX, Math.max(FARE_MIN, n)) * 20) / 20; // pas de 5 %
}

/* ---------- arrêts et durée ---------- */

export const MAX_STOPS = 5;
export const DWELL_MINUTES = 1; // arrêt en gare
export const STOP_DEMAND_BONUS = 0.2; // chaque arrêt apporte ses propres voyageurs
export const STOP_TURNOVER_BONUS = 0.1; // une place libérée à un arrêt se revend sur la suite du trajet

export function routeOf(l: { departureStation: string; arrivalStation: string; stops?: string[] | null }) {
  return [l.departureStation, ...(l.stops ?? []), l.arrivalStation];
}

/* Durée d'un trajet par ses arrêts : la distance parcourue gare après gare,
   plus une minute par arrêt. Sans arrêt, c'est exactement la durée d'avant. */
export function routeDuration(route: string[]) {
  if (route.length <= 2) {
    const km = distanceKm(route[0], route[route.length - 1]);
    return km === null ? null : durationFromKm(km);
  }
  let km = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const d = distanceKm(route[i], route[i + 1]);
    if (d === null) return null;
    km += d;
  }
  const travel = Math.max(3, Math.min(30, Math.round(km / 55)));
  return travel + DWELL_MINUTES * (route.length - 2);
}

export function travelMinutes(durationMinutes: number, stops: number) {
  return Math.max(3, durationMinutes - DWELL_MINUTES * stops);
}

/* ---------- demande ---------- */

/* Voyageurs qu'une liaison attire à chaque passage de train, pour une
   compagnie seule et bien notée, au tarif normal, entre deux villes de
   poids 1 : de quoi remplir une rame Standard et demie. Les grandes villes,
   les arrêts, les événements en gare en attirent plus ; un tarif élevé et
   une mauvaise réputation, moins. */
export const LEG_DEMAND_BASE = 400;

export function legDemand(opts: {
  demandAvg: number; // poids moyen des gares desservies (événements compris)
  stops: number;
  fare: number;
  reputation: number; // 0–100
  competition: number; // part de marché sur la liaison, en multiplicateur (0,6–1,4)
}) {
  // la réputation pèse fort : à 60 %, une liaison n'attire plus que la moitié de ses voyageurs
  const rep = Math.max(0.2, Math.pow(Math.max(0, opts.reputation) / 100, 1.5));
  return LEG_DEMAND_BASE * opts.demandAvg * (1 + STOP_DEMAND_BONUS * opts.stops) * Math.pow(opts.fare, -PRICE_ELASTICITY) * rep * opts.competition;
}

/* Taux de remplissage de toutes les rames d'une compagnie sur une liaison :
   voyageurs par heure / places par heure, plafonné à 100 %. */
export function fillRate(demandPerHour: number, seatsPerHour: number) {
  if (seatsPerHour <= 0) return 0;
  return Math.min(1, demandPerHour / seatsPerHour);
}

export function effectiveDuration(model: string, durationMinutes: number) {
  return model === "EXPRESS" ? durationMinutes * 0.7 : durationMinutes;
}
