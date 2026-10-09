/* Géographie du réseau : c'est la source de vérité pour la durée d'un trajet.

   Depuis que le rendement croît avec la longueur (lengthYield dans
   simulation.job.ts), laisser le client choisir durationMinutes serait une
   porte ouverte : il suffirait de déclarer 20 minutes entre deux gares
   voisines pour toucher +25 % sans rouler plus longtemps. La durée est donc
   recalculée ici à chaque création ou modification de ligne. */

// mêmes positions que la carte du tableau de bord
const STATION_COORDS: Record<string, { x: number; y: number }> = {
  "Lille": { x: 190, y: 20 },
  "Le Havre": { x: 108.13, y: 71 },
  "Rouen": { x: 131.9, y: 71 },
  "Metz": { x: 282.44, y: 85 },
  "Paris": { x: 168.87, y: 96 },
  "Nancy": { x: 282.44, y: 103 },
  "Strasbourg": { x: 324.69, y: 109 },
  "Chartres": { x: 143.78, y: 114 },
  "Rennes": { x: 50.02, y: 128 },
  "Le Mans": { x: 105.49, y: 133 },
  "Mulhouse": { x: 316.77, y: 144 },
  "Dijon": { x: 248.1, y: 162 },
  "Nantes": { x: 53.98, y: 167 },
  "Lyon": { x: 242.82, y: 229 },
  "Grenoble": { x: 269.23, y: 254 },
  "Bordeaux": { x: 81.72, y: 269 },
  "Toulouse": { x: 142.46, y: 322 },
  "Marseille": { x: 258.67, y: 335 },
  // v1.3 — vingt gares de plus, placées avec la même projection (longitude, latitude réelles)
  "Brest": { x: -33.17, y: 116 },
  "Caen": { x: 88.32, y: 82 },
  "Amiens": { x: 167.55, y: 52 },
  "Reims": { x: 219.05, y: 79 },
  "Troyes": { x: 220.37, y: 120 },
  "Orléans": { x: 155.67, y: 137 },
  "Tours": { x: 120.01, y: 159 },
  "Angers": { x: 83.04, y: 156 },
  "Poitiers": { x: 109.45, y: 194 },
  "La Rochelle": { x: 65.87, y: 212 },
  "Limoges": { x: 137.18, y: 226 },
  "Clermont-Ferrand": { x: 190, y: 228 },
  "Saint-Étienne": { x: 229.62, y: 243 },
  "Besançon": { x: 277.16, y: 166 },
  "Avignon": { x: 241.5, y: 307 },
  "Montpellier": { x: 213.77, y: 322 },
  "Nice": { x: 314.13, y: 318 },
  "Perpignan": { x: 184.72, y: 361 },
  "Pau": { x: 88.32, y: 335 },
  "Bayonne": { x: 56.63, y: 327 },
  // v1.6 — les premières gares à l'étranger, même projection (voir international.service)
  "Londres": { x: 96.24, y: -19 },
  "Bruxelles": { x: 228.3, y: 11 },
  "Francfort": { x: 356.39, y: 42 },
  "Genève": { x: 281.12, y: 210 },
  "Milan": { x: 372.23, y: 241 },
  "Barcelone": { x: 162.27, y: 418 },
  // 2.0 — ouvertes par le Grand Chantier (tunnel du Mont-Blanc), voir world.service
  "Turin": { x: 326.84, y: 259 },
  "Zurich": { x: 352.13, y: 160 },
  // 2.0 — extension Montagne (dlc.service), même projection
  "Chamonix": { x: 302.7, y: 222.4 },
  "Bourg-Saint-Maurice": { x: 299.7, y: 235.3 },
  "Briançon": { x: 295.9, y: 266.2 },
  "Font-Romeu": { x: 159.8, y: 369.3 },
};

export const STATIONS = Object.keys(STATION_COORDS);

export function isKnownStation(name: string) {
  return Object.prototype.hasOwnProperty.call(STATION_COORDS, name);
}

/* Projection inverse : on remonte aux degrés pour mesurer en kilomètres. */
export function toLonLat(p: { x: number; y: number }) {
  // 1.6 : 29,58 px par degré de longitude (42,97 × cos 46,5°) : la carte n'est plus étirée en hauteur
  return { lon: 3.06 + (p.x - 190) / 29.58, lat: 50.63 - (p.y - 20) / 42.97 };
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

/* 2.0 : latitude et longitude réelles d'une gare (pour la météo) */
export function stationLonLat(name: string) {
  const p = STATION_COORDS[name];
  return p ? toLonLat(p) : null;
}
