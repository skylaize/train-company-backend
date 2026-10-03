/* ============================================================
   Voyageurs, places et prix (1.7).

   Jusqu'ici, chaque rame posée sur une ligne rapportait autant que la
   première : empiler dix rames sur Paris–Lille était la seule stratégie.
   Désormais une ligne a un nombre de voyageurs par départ, et les rames
   d'une même compagnie se les partagent.

   - Voyageurs par départ : 300 × demande des gares desservies,
     +20 % par arrêt intermédiaire, × part de marché face aux concurrents,
     × l'effet du prix du billet (plus cher = moins de monde).
   - Plusieurs rames sur la ligne : plus de départs attirent plus de monde,
     mais pas proportionnellement (× nombre de rames puissance 0,7).
   - Une rame emporte au plus ses places ; le reste reste sur le quai.
   - Recette : voyageurs × prix, la 1re classe payant 1,8 fois plus.

   À prix normal, une rame Standard seule sur une ligne ordinaire rapporte
   exactement ce qu'elle rapportait en 1.6.
   ============================================================ */

export const BASE_PASSENGERS = 300; // voyageurs d'une ligne ordinaire, par départ
export const STOP_BONUS = 0.2;
export const PRICE_MIN = 0.6;
export const PRICE_MAX = 2;
export const PRICE_ELASTICITY = 1.2;
export const FIRST_CLASS_FARE = 1.8;
export const BAR_BONUS = 1.08;
export const CAR_SLOWDOWN = 0.03; // chaque voiture ajoutée alourdit la rame
export const MAX_CARS = 3;
export const FREQUENCY_EXP = 0.7;

/* Voyageurs qui attendent chaque rame quand `n` rames de la compagnie se partagent la ligne. */
export function perTrainWaiting(perDeparture: number, n: number) {
  const k = Math.max(1, n);
  return (perDeparture * Math.pow(k, FREQUENCY_EXP)) / k;
}

export const MODEL_SEATS: Record<string, number> = { STANDARD: 400, EXPRESS: 400, FRET_LOURD: 200, COUCHETTES: 250 };

export const CARS: Record<string, { label: string; seats: number; first: boolean; price: number; unique?: boolean }> = {
  SECONDE: { label: "Voiture de 2de classe", seats: 100, first: false, price: 150 },
  PREMIERE: { label: "Voiture de 1re classe", seats: 60, first: true, price: 300 },
  BAR: { label: "Voiture-bar", seats: 0, first: false, price: 250, unique: true },
};

export type TrainLike = { model: string; cars?: string[] | null };

export function seatsOf(t: TrainLike) {
  const cars = t.cars ?? [];
  const second = (MODEL_SEATS[t.model] ?? 400) + cars.reduce((n, c) => n + (CARS[c] && !CARS[c].first ? CARS[c].seats : 0), 0);
  const first = cars.reduce((n, c) => n + (CARS[c]?.first ? CARS[c].seats : 0), 0);
  return { second, first, total: second + first };
}

export function speedFactor(t: TrainLike) {
  return 1 + CAR_SLOWDOWN * (t.cars?.length ?? 0);
}

export function clampPrice(r: unknown) {
  const n = Number(r);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(PRICE_MAX, Math.max(PRICE_MIN, n)) * 20) / 20; // pas de 5 %
}

/* Voyageurs qui attendent à chaque départ, sur toute la ligne. */
export function passengersPerDeparture(demand: number, stops: number, share: number, priceRatio: number) {
  return BASE_PASSENGERS * demand * (1 + STOP_BONUS * stops) * share * Math.pow(priceRatio, -PRICE_ELASTICITY);
}

/* Ce qu'emporte une rame quand `n` rames de la compagnie roulent sur la ligne. */
export function tripLoad(t: TrainLike, perDeparture: number, n: number, priceRatio: number) {
  const seats = seatsOf(t);
  const waiting = perTrainWaiting(perDeparture, n);
  const carried = Math.min(seats.total, waiting);
  const firstShare = seats.total ? seats.first / seats.total : 0;
  const p1 = carried * firstShare;
  const p2 = carried - p1;
  const bar = (t.cars ?? []).includes("BAR") ? BAR_BONUS : 1;
  return {
    passengers: Math.round(carried),
    seats: seats.total,
    fill: seats.total ? carried / seats.total : 0,
    left: Math.max(0, Math.round(waiting - carried)), // restés sur le quai
    // recette relative à la référence (300 voyageurs au prix normal)
    revenueFactor: ((p2 + FIRST_CLASS_FARE * p1) / BASE_PASSENGERS) * priceRatio * bar,
  };
}
