import { prisma } from "../prisma";
import { computeReputation } from "./reputation.service";
import { STATIONS } from "./geography.service";

/* ============================================================
   Gares vivantes et concurrence (1.4).

   1. LES GARES ONT UNE TAILLE. Paris n'attire pas autant de voyageurs que
      Chartres : une ligne rapporte selon les deux gares qu'elle relie, et plus
      seulement selon sa durée.

   2. LA DEMANDE BOUGE. Un salon à Lyon, un afflux touristique à Nice, une
      grève à Rennes : des événements de quelques heures, communs à tout le
      réseau, qui font monter ou baisser la fréquentation d'une gare.

   3. LES LIGNES SE PARTAGENT. Deux compagnies sur la même liaison se
      disputent les voyageurs. La plus attractive (réputation, fréquence,
      vitesse, état des rames) en prend aux autres — jusqu'à +40 % pour elle,
      jusqu'à −40 % pour la moins bonne. À attractivité égale, personne ne perd
      rien : la concurrence récompense le mieux-disant, elle ne punit pas le
      simple fait d'être à plusieurs.
   ============================================================ */

/* Taille des gares, de 1 à 5, d'après le poids réel de chaque ville. */
export const STATION_SIZE: Record<string, number> = {
  Paris: 5,
  Lyon: 4, Marseille: 4, Lille: 4, Toulouse: 4, Bordeaux: 4, Nice: 4, Nantes: 4, Strasbourg: 4,
  Montpellier: 3, Rennes: 3, Grenoble: 3, Rouen: 3, Tours: 3, "Clermont-Ferrand": 3, "Saint-Étienne": 3,
  Dijon: 3, Metz: 3, Nancy: 3, "Orléans": 3, Reims: 3, Angers: 3,
  "Le Havre": 2, "Le Mans": 2, Brest: 2, Caen: 2, Amiens: 2, Limoges: 2, Avignon: 2, Mulhouse: 2,
  Perpignan: 2, "Besançon": 2, Poitiers: 2, Pau: 2, Bayonne: 2,
  Chartres: 1, Troyes: 1, "La Rochelle": 1,
};

export const SIZE_LABEL: Record<number, string> = {
  5: "Capitale",
  4: "Métropole",
  3: "Grande ville",
  2: "Ville moyenne",
  1: "Petite ville",
};

/* Poids d'une gare dans la recette d'un trajet. Centré sur 1 : une ligne entre
   deux grandes villes rapporte à peu près ce qu'elle rapportait avant la 1.4,
   une ligne vers la capitale un peu plus, une desserte de petites villes un
   peu moins. */
const SIZE_WEIGHT: Record<number, number> = { 5: 1.2, 4: 1.08, 3: 0.98, 2: 0.9, 1: 0.82 };

export function stationSize(name: string) {
  return STATION_SIZE[name] ?? 2;
}

/* ---------------- événements de gare ---------------- */

interface EventTemplate {
  label: string;
  multiplier: number;
  minHours: number;
  maxHours: number;
  // gares concernées : une liste, ou une taille minimale
  stations?: string[];
  minSize?: number;
}

const EVENT_TEMPLATES: EventTemplate[] = [
  { label: "Salon professionnel", multiplier: 1.35, minHours: 2, maxHours: 4, minSize: 4 },
  { label: "Match au stade", multiplier: 1.25, minHours: 1, maxHours: 2, minSize: 3 },
  { label: "Festival", multiplier: 1.3, minHours: 2, maxHours: 4, minSize: 1 },
  {
    label: "Afflux touristique",
    multiplier: 1.3,
    minHours: 3,
    maxHours: 6,
    stations: ["Nice", "Marseille", "Perpignan", "Bayonne", "La Rochelle", "Montpellier", "Avignon", "Brest", "Paris", "Pau"],
  },
  { label: "Grève locale", multiplier: 0.65, minHours: 1, maxHours: 3, minSize: 1 },
  { label: "Travaux en gare", multiplier: 0.8, minHours: 2, maxHours: 4, minSize: 1 },
];

// au plus quatre événements en cours ou annoncés en même temps
const MAX_EVENTS = 4;
// ≈ 1,8 événement par heure tant qu'il reste de la place : de quoi toujours avoir une nouvelle à lire
const SPAWN_CHANCE_PER_TICK = 0.015;
/* Un événement est annoncé une heure avant de commencer. Les abonnés le voient
   venir et peuvent placer leurs rames ; les autres le découvrent quand il
   démarre. C'est de l'anticipation, pas un bonus : la recette d'un trajet est
   la même pour tous au moment où il arrive. */
export const EVENT_NOTICE_MS = 3600_000;

export type StationEvent = { id: string; station: string; label: string; multiplier: number; startsAt: Date; endsAt: Date };

export async function activeStationEvents(): Promise<StationEvent[]> {
  const now = new Date();
  return (await prisma.stationEvent.findMany({
    where: { startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { endsAt: "asc" },
  })) as StationEvent[];
}

export async function upcomingStationEvents(): Promise<StationEvent[]> {
  return (await prisma.stationEvent.findMany({
    where: { startsAt: { gt: new Date() } },
    orderBy: { startsAt: "asc" },
  })) as StationEvent[];
}

/* Appelée à chaque tour : les événements naissent et meurent que les joueurs
   soient là ou non, comme la météo. */
export async function maybeSpawnStationEvent() {
  const pending = (await prisma.stationEvent.findMany({ where: { endsAt: { gt: new Date() } } })) as StationEvent[];
  if (pending.length >= MAX_EVENTS) return;
  if (Math.random() >= SPAWN_CHANCE_PER_TICK) return;

  const template = EVENT_TEMPLATES[Math.floor(Math.random() * EVENT_TEMPLATES.length)];
  const busy = new Set(pending.map((e) => e.station));
  const candidates = (template.stations ?? STATIONS.filter((s) => stationSize(s) >= (template.minSize ?? 1))).filter(
    (s) => !busy.has(s)
  );
  if (candidates.length === 0) return;

  const station = candidates[Math.floor(Math.random() * candidates.length)];
  const hours = template.minHours + Math.random() * (template.maxHours - template.minHours);
  const startsAt = new Date(Date.now() + EVENT_NOTICE_MS);
  await prisma.stationEvent.create({
    data: {
      station,
      label: template.label,
      multiplier: template.multiplier,
      startsAt,
      endsAt: new Date(startsAt.getTime() + hours * 3600_000),
    },
  });
}

/* Demande d'une gare en ce moment : sa taille, modulée par ses événements. */
export function stationDemand(name: string, events: StationEvent[]) {
  const base = SIZE_WEIGHT[stationSize(name)] ?? 1;
  return events.filter((e) => e.station === name).reduce((m, e) => m * e.multiplier, base);
}

/* Facteur de demande d'une ligne : la moyenne de ses deux gares. */
export function lineDemand(a: string, b: string, events: StationEvent[]) {
  return (stationDemand(a, events) + stationDemand(b, events)) / 2;
}

export function lineHasBoost(a: string, b: string, events: StationEvent[]) {
  return events.some((e) => (e.station === a || e.station === b) && e.multiplier > 1);
}

/* ---------------- concurrence ---------------- */

export function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export const SHARE_FLOOR = 0.6;
export const SHARE_CEIL = 1.4;

export interface Contender {
  companyId: string;
  name: string;
  emblem: string | null;
  trains: number;
  attractiveness: number;
  // détail de l'attractivité, montré aux abonnés (veille concurrentielle)
  reputation: number;
  express: number; // part de rames Express, 0–1
  comfort: number; // 1 = rames neuves, 0,5 = à bout
  share: number; // part des voyageurs, 0–1
  multiplier: number; // effet sur la recette de chaque trajet
}

/* Attractivité d'une compagnie sur une liaison :
   - réputation : la ponctualité, c'est ce qui fait revenir un voyageur ;
   - fréquence : racine du nombre de rames, pour qu'aligner dix rames ne suffise pas à écraser la ligne ;
   - vitesse : une rame Express attire 30 % de voyageurs de plus ;
   - confort : des rames usées font fuir, d'où l'intérêt des révisions préventives. */
function attractiveness(reputation: number, trains: { model: string; wear: number }[]) {
  const n = trains.length;
  if (n === 0) return 0;
  const speed = trains.reduce((s, t) => s + (t.model === "EXPRESS" ? 1.3 : 1), 0) / n;
  const comfort = 1 - trains.reduce((s, t) => s + t.wear, 0) / n / 200; // 1 (neuves) → 0,5 (à bout)
  const rep = 0.4 + 0.6 * (reputation / 100);
  return rep * Math.sqrt(n) * speed * comfort;
}

/* Carte de la concurrence sur tout le réseau, pour les rames en service. Un
   seul calcul par tour de simulation, et un à chaque consultation de la carte. */
export async function competitionMap(): Promise<Map<string, Contender[]>> {
  const trains = (await prisma.train.findMany({
    where: { status: "EN_ROUTE", lineId: { not: null } },
    select: {
      companyId: true,
      model: true,
      wear: true,
      line: { select: { departureStation: true, arrivalStation: true } },
      company: { select: { name: true, emblem: true } },
    },
  })) as {
    companyId: string;
    model: string;
    wear: number;
    line: { departureStation: string; arrivalStation: string } | null;
    company: { name: string; emblem: string | null };
  }[];

  // liaison → compagnie → ses rames
  const byPair = new Map<string, Map<string, { name: string; emblem: string | null; trains: { model: string; wear: number }[] }>>();
  for (const t of trains) {
    if (!t.line) continue;
    const key = pairKey(t.line.departureStation, t.line.arrivalStation);
    let companies = byPair.get(key);
    if (!companies) byPair.set(key, (companies = new Map()));
    let entry = companies.get(t.companyId);
    if (!entry) companies.set(t.companyId, (entry = { name: t.company.name, emblem: t.company.emblem, trains: [] }));
    entry.trains.push({ model: t.model, wear: t.wear });
  }

  // réputation seulement pour les compagnies qui ont de la concurrence : c'est une requête chacune
  const needRep = new Set<string>();
  for (const companies of byPair.values()) if (companies.size > 1) companies.forEach((_, id) => needRep.add(id));
  const reputation = new Map<string, number>();
  await Promise.all([...needRep].map(async (id) => reputation.set(id, await computeReputation(id))));

  const out = new Map<string, Contender[]>();
  for (const [key, companies] of byPair) {
    const n = companies.size;
    const list: Contender[] = [...companies.entries()].map(([companyId, c]) => {
      const rep = reputation.get(companyId) ?? 80;
      return {
        companyId,
        name: c.name,
        emblem: c.emblem,
        trains: c.trains.length,
        attractiveness: n > 1 ? attractiveness(rep, c.trains) : 1,
        reputation: rep,
        express: c.trains.filter((t) => t.model === "EXPRESS").length / c.trains.length,
        comfort: 1 - c.trains.reduce((s, t) => s + t.wear, 0) / c.trains.length / 200,
        share: 1,
        multiplier: 1,
      };
    });
    const total = list.reduce((s, c) => s + c.attractiveness, 0) || 1;
    for (const c of list) {
      c.share = n > 1 ? c.attractiveness / total : 1;
      // à parts égales, multiplicateur 1 : la concurrence ne coûte rien à celui qui fait aussi bien que les autres
      c.multiplier = n > 1 ? Math.min(SHARE_CEIL, Math.max(SHARE_FLOOR, c.share * n)) : 1;
    }
    list.sort((a, b) => b.share - a.share);
    out.set(key, list);
  }
  return out;
}

/* ---------------- veille concurrentielle ---------------- */

/* Tous les dix tours (5 min) : on compare la concurrence de chaque ligne à son
   dernier état connu. Une compagnie qui arrive sur la liaison, ou qui passe
   devant, déclenche une notification chez les abonnés. L'état est tenu à jour
   pour tout le monde, pour qu'un joueur qui devient Premium ne reçoive pas
   d'un coup des alertes sur des changements anciens. */
export async function watchCompetition(
  map: Map<string, Contender[]>,
  notify: (companyId: string, title: string, body: string) => Promise<void>
) {
  const lines = (await prisma.line.findMany({
    select: {
      id: true,
      companyId: true,
      departureStation: true,
      arrivalStation: true,
      rivals: true,
      leading: true,
      company: { select: { isPremium: true } },
    },
  })) as {
    id: string; companyId: string; departureStation: string; arrivalStation: string;
    rivals: number; leading: boolean; company: { isPremium: boolean };
  }[];

  for (const l of lines) {
    const contenders = map.get(pairKey(l.departureStation, l.arrivalStation)) ?? [];
    const mine = contenders.find((c) => c.companyId === l.companyId);
    // une ligne sans rame en service n'est pas en compétition : on garde l'état tel quel
    if (!mine) continue;
    const rivals = contenders.length - 1;
    const leading = contenders[0]?.companyId === l.companyId;
    if (rivals === l.rivals && leading === l.leading) continue;

    await prisma.line.update({ where: { id: l.id }, data: { rivals, leading } });
    if (!l.company.isPremium) continue;

    const label = `${l.departureStation} → ${l.arrivalStation}`;
    if (rivals > l.rivals) {
      await notify(
        l.companyId,
        "Concurrence sur votre ligne",
        `${rivals > 1 ? `${rivals} compagnies exploitent` : `${contenders.find((c) => c.companyId !== l.companyId)?.name ?? "Une compagnie"} exploite`} aussi ${label}. Vous gardez ${Math.round(mine.share * 100)} % des voyageurs.`
      );
    } else if (l.leading && !leading && rivals > 0) {
      await notify(l.companyId, "Vous n'êtes plus en tête", `${contenders[0].name} vous passe devant sur ${label} : ${Math.round(mine.share * 100)} % des voyageurs pour vous.`);
    } else if (!l.leading && leading && rivals > 0) {
      await notify(l.companyId, "Vous reprenez la tête", `${label} : ${Math.round(mine.share * 100)} % des voyageurs sont à vous.`);
    }
  }
}
