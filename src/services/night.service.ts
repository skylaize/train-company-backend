import { isInternational } from "./international.service";

/* ============================================================
   2.1.1 : les trains de nuit internationaux.

   La rame couchettes (1.6) fait la nuit en France. Le train de nuit
   international, lui, relie la France à l'étranger : voitures-lits,
   voiture-restaurant, on s'endort à Paris et on se réveille à Milan ou à
   Barcelone. Il demande la licence internationale et ne roule que sur les
   grandes lignes qui passent une frontière.

   De nuit, il rapporte comme une couchettes (×3), avec un billet de
   voiture-lits plus cher (×1,3) et un sillon de nuit à moitié prix au
   réseau étranger. De jour, il fait la navette à vide ou presque (×0,6) :
   c'est une rame qu'on achète pour la nuit.
   ============================================================ */

export const NIGHT_INTL_MODEL = "NUIT_EUROPE";
export const NIGHT_INTL_COST = 2400;
export const NIGHT_INTL_MIN_GRADE = 3; // Baron du rail, comme la licence
export const NIGHT_INTL_SEATS = 200;
export const NIGHT_INTL_FARE = 1.3; // billet de voiture-lits
export const NIGHT_INTL_DAY = 0.6; // de jour, presque vide
export const NIGHT_INTL_TOLL = 0.5; // sillon de nuit : péage à moitié prix

export const isNightIntl = (model: string) => model === NIGHT_INTL_MODEL;

/* une ligne qu'il peut faire : au moins une gare étrangère, et une grande ligne */
export function nightIntlLineError(route: string[], durationMinutes: number, minDuration: number) {
  if (!route.some(isInternational)) return "Un train de nuit international relie la France à l'étranger : choisissez une ligne qui passe une frontière";
  if (durationMinutes < minDuration) return `Un train de nuit international ne fait que les grandes lignes (${minDuration} min de trajet ou plus)`;
  return null;
}
