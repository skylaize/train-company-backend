import { parisDate, parisMidnight } from "./time.service";
import type { StationEvent } from "./station.service";

/* ============================================================
   Événements saisonniers (1.5).

   Quatre temps forts dans l'année, au calendrier de Paris. Pendant chacun,
   quelques gares attirent plus de voyageurs pour tout le réseau, un objet de
   boutique n'est vendu que ce temps-là, et un succès ne peut être gagné
   qu'à ce moment. Hors saison, il ne se passe rien de spécial : c'est ce qui
   donne envie de revenir quand ça commence.

   Côté simulation, un événement saisonnier se comporte exactement comme un
   événement de gare (voir station.service) : il s'ajoute à la liste des
   événements du moment, et la demande, la carte et la mention « affluence »
   des recettes en tiennent compte sans rien changer d'autre.
   ============================================================ */

export interface SeasonalEvent {
  id: string;
  name: string;
  blurb: string;
  from: [number, number]; // [mois, jour], inclus
  to: [number, number]; // [mois, jour], inclus
  stations: string[];
  multiplier: number;
  shopItemId: string;
  achievementId: string;
}

export const SEASONAL_EVENTS: SeasonalEvent[] = [
  {
    id: "vendanges",
    name: "Les Vendanges",
    blurb: "Les vignobles attirent le monde : Bordeaux, la Champagne, la Bourgogne, la vallée du Rhône, la Loire et l'Alsace.",
    from: [9, 15],
    to: [10, 31],
    stations: ["Bordeaux", "Reims", "Dijon", "Avignon", "Tours", "Mulhouse"],
    multiplier: 1.2,
    shopItemId: "coffret-vendanges",
    achievementId: "vendangeur",
  },
  {
    id: "noel",
    name: "Les Marchés de Noël",
    blurb: "Les marchés de l'Est et les lumières de Lyon font le plein de voyageurs jusqu'au réveillon.",
    from: [11, 27],
    to: [12, 31],
    stations: ["Strasbourg", "Mulhouse", "Metz", "Nancy", "Reims", "Lille", "Lyon"],
    multiplier: 1.25,
    shopItemId: "coffret-noel",
    achievementId: "esprit-de-noel",
  },
  {
    id: "neige",
    name: "Les Vacances de neige",
    blurb: "Direction les montagnes : Alpes, Massif central, Pyrénées et Jura.",
    from: [2, 6],
    to: [3, 8],
    stations: ["Grenoble", "Clermont-Ferrand", "Pau", "Besançon", "Lyon"],
    multiplier: 1.25,
    shopItemId: "coffret-neiges",
    achievementId: "neiges-eternelles",
  },
  {
    id: "ete",
    name: "Les Grandes Vacances",
    blurb: "Tout le monde part à la mer : Méditerranée, Atlantique et Bretagne.",
    from: [7, 4],
    to: [8, 31],
    stations: ["Nice", "Marseille", "Montpellier", "Perpignan", "Bayonne", "La Rochelle", "Brest", "Avignon"],
    multiplier: 1.2,
    shopItemId: "coffret-ete",
    achievementId: "grandes-vacances",
  },
];

/* Dates d'une édition : de minuit le premier jour à minuit le lendemain du dernier. */
function edition(ev: SeasonalEvent, year: number) {
  const start = parisMidnight(year, ev.from[0], ev.from[1]);
  const end = parisMidnight(year, ev.to[0], ev.to[1] + 1);
  return { start, end };
}

/* L'édition en cours, ou la dernière passée : c'est sur elle que se comptent
   les trajets du succès de saison. */
export function latestEdition(ev: SeasonalEvent, now = new Date()) {
  const { year } = parisDate(now);
  const cur = edition(ev, year);
  return cur.start <= now ? cur : edition(ev, year - 1);
}

export function nextEdition(ev: SeasonalEvent, now = new Date()) {
  const { year } = parisDate(now);
  const cur = edition(ev, year);
  return cur.end > now ? cur : edition(ev, year + 1);
}

export function activeSeasonalEvent(now = new Date()) {
  for (const ev of SEASONAL_EVENTS) {
    const e = nextEdition(ev, now);
    if (e.start <= now && now < e.end) return { ...ev, startsAt: e.start, endsAt: e.end };
  }
  return null;
}

/* Le prochain temps fort, pour l'annoncer quand il n'y a rien en cours. */
export function upcomingSeasonalEvent(now = new Date()) {
  return SEASONAL_EVENTS.map((ev) => ({ ...ev, ...(() => { const e = nextEdition(ev, now); return { startsAt: e.start, endsAt: e.end }; })() }))
    .filter((e) => e.startsAt > now)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0] ?? null;
}

/* Les gares de la saison, au format des événements de gare. */
export function seasonalStationEvents(now = new Date()): StationEvent[] {
  const ev = activeSeasonalEvent(now);
  if (!ev) return [];
  return ev.stations.map((station) => ({
    id: `saison-${ev.id}-${station}`,
    station,
    label: ev.name,
    multiplier: ev.multiplier,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
  }));
}

export function seasonalEventById(id: string) {
  return SEASONAL_EVENTS.find((e) => e.id === id) ?? null;
}
