import { parisHour } from "./time.service";

/* ============================================================
   Heures de pointe (1.7).

   Les voyageurs ne viennent pas à la même heure toute la journée : beaucoup
   de monde de 7 h à 9 h et de 17 h à 19 h, peu l'après-midi, très peu la nuit.
   La courbe multiplie la demande de toutes les lignes. Elle vaut 1 en moyenne
   sur la journée : une rame qui a assez de places pour la pointe gagne autant
   qu'avant, une rame trop petite laisse du monde à quai le matin et le soir.

   Les rames couchettes n'y sont pas soumises : elles ont leur propre service
   de nuit (time.service).
   ============================================================ */

const RAW = [
  0.5, 0.5, 0.5, 0.5, 0.5, 0.6, // 0 h – 5 h
  0.85, 1.5, 1.5, 1.2, // 6 h – 9 h
  0.95, 0.95, 1.1, 1.1, // 10 h – 13 h
  0.8, 0.8, 1.05, // 14 h – 16 h
  1.5, 1.5, 1.25, // 17 h – 19 h
  1.0, 0.85, 0.7, 0.6, // 20 h – 23 h
];
const MEAN = RAW.reduce((a, x) => a + x, 0) / RAW.length;

/* Multiplicateur de demande de chaque heure de la journée (heure de Paris), de moyenne 1. */
export const PEAK_CURVE = RAW.map((x) => Math.round((x / MEAN) * 100) / 100);

export const PEAK_HOURS = [7, 8, 17, 18];
export const OFF_PEAK_HOURS = [14, 15];

export function peakFactor(at = new Date()) {
  return PEAK_CURVE[parisHour(at)];
}

export type PeakKind = "pointe" | "creuse" | "nuit" | "normale";

export function kindOf(hour: number): PeakKind {
  if (PEAK_HOURS.includes(hour)) return "pointe";
  if (OFF_PEAK_HOURS.includes(hour)) return "creuse";
  if (hour >= 22 || hour < 6) return "nuit";
  return "normale";
}

/* Ce qu'affiche le jeu : l'affluence de l'heure, jusqu'à quand elle dure, et la courbe du jour. */
export function peakInfo(at = new Date()) {
  const hour = parisHour(at);
  const kind = kindOf(hour);
  let until = (hour + 1) % 24;
  while (kindOf(until) === kind && until !== hour) until = (until + 1) % 24;
  return { hour, kind, factor: PEAK_CURVE[hour], until, curve: PEAK_CURVE };
}
