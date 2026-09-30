/* ============================================================
   Heure de Paris.

   Le serveur tourne en UTC, mais le jeu vit à l'heure française : la semaine
   commence le lundi à 0 h à Paris, les saisons suivent le calendrier français.
   Tout passe par ici pour ne jamais se tromper d'une heure au changement
   d'heure.
   ============================================================ */

/* Décalage de Paris par rapport à UTC à un instant donné, en millisecondes
   (+1 h l'hiver, +2 h l'été). */
export function parisOffsetMs(at: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((x) => [x.type, x.value])
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/* Date du calendrier parisien : année, mois (1–12), jour. */
export function parisDate(at = new Date()) {
  const local = new Date(at.getTime() + parisOffsetMs(at));
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate(), weekday: (local.getUTCDay() + 6) % 7 };
}

/* Minuit à Paris, un jour donné (mois 1–12), en instant UTC. Le décalage est
   recalculé à l'instant visé, ce qui règle les jours de changement d'heure. */
export function parisMidnight(year: number, month: number, day: number) {
  const local = Date.UTC(year, month - 1, day);
  let guess = local - parisOffsetMs(new Date(local));
  guess = local - parisOffsetMs(new Date(guess));
  return new Date(guess);
}

/* Début de la semaine en cours : lundi 00 h 00, heure de Paris. */
export function startOfParisWeek(now = new Date()) {
  const d = parisDate(now);
  return parisMidnight(d.year, d.month, d.day - d.weekday);
}

export const DAY_MS = 86_400_000;

/* Heure de Paris (0–23) à un instant donné. */
export function parisHour(at = new Date()) {
  return new Date(at.getTime() + parisOffsetMs(at)).getUTCHours();
}

/* Service de nuit (1.6) : de 22 h à 6 h, heure de Paris. */
export const NIGHT_FROM = 22;
export const NIGHT_TO = 6;
export function isNightService(at = new Date()) {
  const h = parisHour(at);
  return h >= NIGHT_FROM || h < NIGHT_TO;
}

/* Trains de nuit : de 22 h à 6 h, un trajet en rame couchettes rapporte trois
   fois plus ; le jour, 20 % de moins qu'une rame assise. Sur une journée, elle
   rapporte environ une fois et demie une rame Standard, pour un prix plus de
   quatre fois plus élevé. */
export const NIGHT_MULTIPLIER = 3;
export const DAY_COUCHETTES_MULTIPLIER = 0.8;
