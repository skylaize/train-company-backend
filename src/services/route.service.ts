import { durationBetween, isKnownStation } from "./geography.service";

/* ============================================================
   Itinéraires (1.7) : une ligne peut s'arrêter en route.

   Paris → Dijon → Lyon → Marseille : jusqu'à quatre arrêts entre les deux
   terminus. La durée est la somme des tronçons, plus une minute d'arrêt
   par gare intermédiaire. Chaque arrêt fait monter du monde (voir
   ridership.service) : omnibus ou direct, c'est un vrai choix.
   ============================================================ */

export const MAX_STOPS = 4;
export const DWELL_MIN = 1;

export type LineRoute = { departureStation: string; arrivalStation: string; stops?: string[] | null };

export function routeOf(l: LineRoute) {
  return [l.departureStation, ...(l.stops ?? []), l.arrivalStation];
}

/* Le même itinéraire dans le sens où roule la rame (0 = aller, 1 = retour). */
export function routeInDirection(l: LineRoute, direction: number) {
  const r = routeOf(l);
  return direction === 1 ? [...r].reverse() : r;
}

export function routeDuration(route: string[]) {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) total += durationBetween(route[i], route[i + 1]) ?? 0;
  return total + DWELL_MIN * Math.max(0, route.length - 2);
}

/* Nettoie et vérifie les arrêts envoyés par le client. */
export function cleanStops(raw: unknown, dep: string, arr: string): { stops: string[] } | { error: string } {
  if (raw === undefined || raw === null) return { stops: [] };
  if (!Array.isArray(raw)) return { error: "Les arrêts doivent être une liste de gares" };
  const stops = raw.map((s) => String(s).trim()).filter(Boolean);
  if (stops.length > MAX_STOPS) return { error: `Une ligne s'arrête dans ${MAX_STOPS} gares au plus` };
  const all = [dep, ...stops, arr];
  if (stops.some((s) => !isKnownStation(s))) return { error: "Gare inconnue du réseau" };
  if (new Set(all).size !== all.length) return { error: "Une gare ne peut apparaître qu'une fois sur la ligne" };
  return { stops };
}
