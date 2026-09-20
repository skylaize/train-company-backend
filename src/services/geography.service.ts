/* Géographie du réseau : c'est la source de vérité pour la durée d'un trajet.

   Depuis que le rendement croît avec la longueur (lengthYield dans
   simulation.job.ts), laisser le client choisir durationMinutes serait une
   porte ouverte : il suffirait de déclarer 20 minutes entre deux gares
   voisines pour toucher +25 % sans rouler plus longtemps. La durée est donc
   recalculée ici à chaque création ou modification de ligne. */

// mêmes positions que la carte du tableau de bord
const STATION_COORDS: Record<string, { x: number; y: number }> = {
  "Lille": { x: 190, y: 20 },
  "Le Havre": { x: 128, y: 71 },
  "Rouen": { x: 146, y: 71 },
  "Metz": { x: 260, y: 85 },
  "Paris": { x: 174, y: 96 },
  "Nancy": { x: 260, y: 103 },
  "Strasbourg": { x: 292, y: 109 },
  "Chartres": { x: 155, y: 114 },
  "Rennes": { x: 84, y: 128 },
  "Le Mans": { x: 126, y: 133 },
  "Mulhouse": { x: 286, y: 144 },
  "Dijon": { x: 234, y: 162 },
  "Nantes": { x: 87, y: 167 },
  "Lyon": { x: 230, y: 229 },
  "Grenoble": { x: 250, y: 254 },
  "Bordeaux": { x: 108, y: 269 },
  "Toulouse": { x: 154, y: 322 },
  "Marseille": { x: 242, y: 335 },
};

export const STATIONS = Object.keys(STATION_COORDS);

export function isKnownStation(name: string) {
  return Object.prototype.hasOwnProperty.call(STATION_COORDS, name);
}

/* Projection inverse : on remonte aux degrés pour mesurer en kilomètres. */
function toLonLat(p: { x: number; y: number }) {
  return { lon: 3.06 + (p.x - 190) / 22.4, lat: 50.63 - (p.y - 20) / 42.97 };
}

export function distanceKm(a: string, b: string): number | null {
  const pa = STATION_COORDS[a];
  const pb = STATION_COORDS[b];
  if (!pa || !pb) return null;
  const A = toLonLat(pa);
  const B = toLonLat(pb);
  const midLat = ((A.lat + B.lat) / 2) * (Math.PI / 180);
  const dx = (B.lon - A.lon) * 111.32 * Math.cos(midLat);
  const dy = (B.lat - A.lat) * 110.57;
  return Math.round(Math.hypot(dx, dy));
}

/* Doit rester aligné sur durationFromKm() côté client. */
export function durationFromKm(km: number) {
  return Math.max(3, Math.min(20, Math.round(km / 55)));
}

/* Durée officielle d'un trajet entre deux gares connues. */
export function durationBetween(a: string, b: string): number | null {
  const km = distanceKm(a, b);
  return km === null ? null : durationFromKm(km);
}
