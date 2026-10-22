import { prisma } from "../prisma";
import { parisDate, parisMidnight, parisHour } from "./time.service";
import type { StationEvent } from "./station.service";

/* ============================================================
   2.2 : Halloween sur le réseau.

   Du 27 octobre au 2 novembre (heure de Paris), le Train fantôme hante le
   réseau : toutes les 45 minutes, il s'installe dans une gare desservie par
   au moins une compagnie. Pendant sa hantise :
   - la gare attire les curieux (demande ×1,3, mention « affluence ») ;
   - chaque trajet voyageurs dont l'itinéraire passe par elle récolte une
     âme, deux de 20 h à 6 h (les fantômes sortent la nuit).

   L'horaire est public et tracé à l'avance (6 heures devant nous, complété
   au fil de l'eau avec les gares du moment) : on peut voir où il ira et y
   envoyer ses rames. Les âmes débloquent des objets pour toujours, à 10,
   60, 150 et 300 âmes, et un classement des chasseurs court toute la
   semaine. Pour essayer en dehors des dates : HALLOWEEN_START (date ISO) et
   HALLOWEEN_DAYS.
   ============================================================ */

export const HAUNT_MINUTES = 45;
export const HAUNT_DEMAND = 1.3;
export const PLAN_AHEAD_MS = 6 * 3_600_000;
export const NIGHT_SOULS_FROM = 20;
export const NIGHT_SOULS_TO = 6;

export const PUMPKIN_EMBLEM = "citrouille";
export const GHOST_EMBLEM = "fantome";
export const GHOST_TITLE = "Chasseur de fantômes";
export const SPECTRAL_LIVERY = "#6b4c9a";

export type HalloweenTier = { souls: number; kind: "emblem" | "title" | "livery"; value: string; label: string };
export const TIERS: HalloweenTier[] = [
  { souls: 10, kind: "emblem", value: PUMPKIN_EMBLEM, label: "L'emblème de la citrouille" },
  { souls: 60, kind: "title", value: GHOST_TITLE, label: `Le titre « ${GHOST_TITLE} »` },
  { souls: 150, kind: "livery", value: SPECTRAL_LIVERY, label: "La livrée spectrale" },
  { souls: 300, kind: "emblem", value: GHOST_EMBLEM, label: "L'emblème du fantôme" },
];

const MS = { min: 60_000, day: 86_400_000 };

export type Haunt = { station: string; at: string };

/* ---------------- les dates ---------------- */

/* L'édition d'une année : du 27 octobre 0 h au 3 novembre 0 h (Paris). */
export function editionOf(year: number) {
  const env = process.env.HALLOWEEN_START ? new Date(process.env.HALLOWEEN_START) : null;
  if (env && !Number.isNaN(env.getTime()) && parisDate(env).year === year) {
    const days = Math.max(1, Number(process.env.HALLOWEEN_DAYS) || 7);
    return { year, start: env, end: new Date(env.getTime() + days * MS.day) };
  }
  return { year, start: parisMidnight(year, 10, 27), end: parisMidnight(year, 11, 3) };
}

/* L'édition qui nous concerne : en cours, à venir dans l'année, ou la dernière passée. */
export function currentEdition(now = new Date()) {
  const y = parisDate(now).year;
  const ed = editionOf(y);
  return now < ed.start && parisDate(now).month < 6 ? editionOf(y - 1) : ed;
}

export function halloweenActive(now = new Date()) {
  const ed = currentEdition(now);
  return now >= ed.start && now < ed.end;
}

const trainId = (year: number) => `halloween-${year}`;

/* ---------------- l'horaire du Train fantôme ---------------- */

let cache: { year: number; route: Haunt[]; at: number } | null = null;

async function servedStations() {
  const lines = (await prisma.line.findMany({ select: { companyId: true, departureStation: true, arrivalStation: true, stops: true } })) as {
    companyId: string; departureStation: string; arrivalStation: string; stops: string[];
  }[];
  // nombre de compagnies par gare : une gare très desservie est un peu plus souvent hantée
  const companies = new Map<string, Set<string>>();
  for (const l of lines) {
    for (const s of [l.departureStation, ...(l.stops ?? []), l.arrivalStation]) {
      const set = companies.get(s) ?? new Set<string>();
      set.add(l.companyId);
      companies.set(s, set);
    }
  }
  return [...companies.entries()].map(([station, set]) => ({ station, weight: Math.sqrt(set.size) }));
}

function pick(stations: { station: string; weight: number }[], recent: string[]) {
  const pool = stations.filter((s) => !recent.includes(s.station));
  const list = pool.length ? pool : stations;
  const total = list.reduce((a, s) => a + s.weight, 0);
  let r = Math.random() * total;
  for (const s of list) {
    r -= s.weight;
    if (r <= 0) return s.station;
  }
  return list[list.length - 1].station;
}

/* Trace (ou complète) l'horaire jusqu'à 6 heures devant nous. Appelé à
   chaque tour de simulation pendant l'édition. */
export async function planHaunts(now = new Date()) {
  const ed = currentEdition(now);
  if (now < ed.start || now >= ed.end) return null;
  const id = trainId(ed.year);
  let row = (await prisma.specialTrain.findUnique({ where: { id } })) as { route: unknown } | null;
  let route = (row?.route as Haunt[] | undefined) ?? [];
  const horizon = Math.min(ed.end.getTime(), now.getTime() + PLAN_AHEAD_MS);
  const lastAt = route.length ? new Date(route[route.length - 1].at).getTime() : ed.start.getTime() - HAUNT_MINUTES * MS.min;
  if (lastAt + HAUNT_MINUTES * MS.min < horizon) {
    const stations = await servedStations();
    if (!stations.length) return route;
    const next = [...route];
    // un oubli (serveur arrêté) ne laisse pas de trou : on repart de maintenant
    let t = Math.max(lastAt + HAUNT_MINUTES * MS.min, route.length ? 0 : ed.start.getTime());
    if (t < now.getTime() - HAUNT_MINUTES * MS.min) t = now.getTime() - ((now.getTime() - ed.start.getTime()) % (HAUNT_MINUTES * MS.min));
    while (t < horizon) {
      const recent = next.slice(-8).map((h) => h.station);
      next.push({ station: pick(stations, recent), at: new Date(t).toISOString() });
      t += HAUNT_MINUTES * MS.min;
    }
    route = next;
    if (row) {
      await prisma.specialTrain.update({ where: { id }, data: { route: route as unknown as object } });
    } else {
      try {
        await prisma.specialTrain.create({ data: { id, startsAt: ed.start, endsAt: ed.end, route: route as unknown as object } });
      } catch {
        // un autre serveur l'a tracé au même moment : on garde le sien
        row = (await prisma.specialTrain.findUnique({ where: { id } })) as { route: unknown } | null;
        route = (row?.route as Haunt[] | undefined) ?? route;
      }
    }
  }
  cache = { year: ed.year, route, at: Date.now() };
  return route;
}

export async function hauntSchedule(now = new Date()) {
  const ed = currentEdition(now);
  if (cache && cache.year === ed.year && Date.now() - cache.at < 60_000) return cache.route;
  const row = (await prisma.specialTrain.findUnique({ where: { id: trainId(ed.year) } })) as { route: unknown } | null;
  const route = (row?.route as Haunt[] | undefined) ?? [];
  cache = { year: ed.year, route, at: Date.now() };
  return route;
}

/* La hantise en cours d'après un horaire (le dernier créneau commencé). */
export function hauntAt(route: Haunt[], now = new Date()): (Haunt & { until: string }) | null {
  const ed = currentEdition(now);
  if (now < ed.start || now >= ed.end) return null;
  let cur: Haunt | null = null;
  for (const h of route) {
    if (new Date(h.at).getTime() <= now.getTime()) cur = h;
    else break;
  }
  if (!cur) return null;
  const until = new Date(Math.min(ed.end.getTime(), new Date(cur.at).getTime() + HAUNT_MINUTES * MS.min));
  return now < until ? { ...cur, until: until.toISOString() } : null;
}

/* Pour la simulation (synchrone) : la gare hantée, d'après le dernier horaire lu. */
export function hauntedStationNow(now = new Date()) {
  if (!cache || !halloweenActive(now)) return null;
  return hauntAt(cache.route, now)?.station ?? null;
}

/* La gare hantée, au format des événements de gare (demande, affluence, carte). */
export function hauntStationEvents(now = new Date()): StationEvent[] {
  if (!cache || !halloweenActive(now)) return [];
  const h = hauntAt(cache.route, now);
  if (!h) return [];
  return [{ id: `halloween-${h.at}`, station: h.station, label: "Le Train fantôme", multiplier: HAUNT_DEMAND, startsAt: new Date(h.at), endsAt: new Date(h.until) }];
}

/* ---------------- les âmes ---------------- */

export function soulsPerTrip(at = new Date()) {
  const h = parisHour(at);
  return h >= NIGHT_SOULS_FROM || h < NIGHT_SOULS_TO ? 2 : 1;
}

const pending = new Map<string, number>();

/* Un trajet arrivé : s'il dessert la gare hantée, il rapporte ses âmes (écrites en fin de tour). */
export function collectSouls(companyId: string, route: string[], now = new Date()) {
  const st = hauntedStationNow(now);
  if (!st || !route.includes(st)) return 0;
  const n = soulsPerTrip(now);
  pending.set(companyId, (pending.get(companyId) ?? 0) + n);
  return n;
}

/* Écrit les âmes du tour, et prévient au franchissement d'un palier. */
export async function flushSouls(notify?: (companyId: string, title: string, body: string) => Promise<void>) {
  if (!pending.size) return;
  const year = currentEdition().year;
  const batch = [...pending.entries()];
  pending.clear();
  for (const [companyId, n] of batch) {
    const row = (await prisma.halloweenSoul.upsert({
      where: { year_companyId: { year, companyId } },
      create: { year, companyId, souls: n },
      update: { souls: { increment: n } },
    })) as { souls: number };
    const crossed = TIERS.filter((t) => row.souls >= t.souls && row.souls - n < t.souls);
    for (const t of crossed) {
      await notify?.(companyId, `${t.souls} âmes récoltées`, `${t.label} est à vous, pour toujours. Retrouvez-le dans Paramètres.`).catch(() => undefined);
    }
  }
}

/* Ce que les âmes ont fait gagner, toutes éditions confondues. */
export async function halloweenUnlocks(companyId: string) {
  const best = (await prisma.halloweenSoul.findFirst({ where: { companyId }, orderBy: { souls: "desc" }, select: { souls: true } }).catch(() => null)) as { souls: number } | null;
  const souls = best?.souls ?? 0;
  const won = TIERS.filter((t) => souls >= t.souls);
  return {
    souls,
    emblems: won.filter((t) => t.kind === "emblem").map((t) => t.value),
    titles: won.filter((t) => t.kind === "title").map((t) => t.value),
    liveries: won.filter((t) => t.kind === "livery").map((t) => t.value),
  };
}

export async function bestSouls(companyId: string) {
  return (await halloweenUnlocks(companyId)).souls;
}

export async function topHunters(year: number, take = 10) {
  const rows = (await prisma.halloweenSoul.findMany({ where: { year, souls: { gt: 0 } }, orderBy: { souls: "desc" }, take })) as { companyId: string; souls: number }[];
  const names = (await prisma.company.findMany({ where: { id: { in: rows.map((r) => r.companyId) } }, select: { id: true, name: true, liveryColor: true } })) as {
    id: string; name: string; liveryColor: string;
  }[];
  const byId = new Map(names.map((c) => [c.id, c]));
  return rows.filter((r) => byId.has(r.companyId)).map((r, i) => ({ rank: i + 1, companyId: r.companyId, name: byId.get(r.companyId)!.name, livery: byId.get(r.companyId)!.liveryColor, souls: r.souls }));
}

/* ---------------- la vue du joueur ---------------- */

const SHOW_BEFORE_MS = 7 * MS.day;
const SHOW_AFTER_MS = 4 * MS.day;

export async function halloweenView(companyId: string | null, now = new Date()) {
  const ed = currentEdition(now);
  const t = now.getTime();
  const visible = t >= ed.start.getTime() - SHOW_BEFORE_MS && t < ed.end.getTime() + SHOW_AFTER_MS;
  if (!visible) return { visible: false as const };
  const phase = t < ed.start.getTime() ? "avant" : t < ed.end.getTime() ? "pendant" : "apres";

  const route = phase === "pendant" ? await hauntSchedule(now) : [];
  const haunt = hauntAt(route, now);
  const next = route.filter((h) => new Date(h.at).getTime() > t).slice(0, 4);

  let mine = { souls: 0, rank: null as number | null, served: [] as string[], best: 0 };
  if (companyId) {
    const [row, lines, best] = await Promise.all([
      prisma.halloweenSoul.findUnique({ where: { year_companyId: { year: ed.year, companyId } } }),
      prisma.line.findMany({ where: { companyId }, select: { departureStation: true, arrivalStation: true, stops: true } }),
      bestSouls(companyId),
    ]);
    const souls = (row as { souls: number } | null)?.souls ?? 0;
    const rank = souls > 0 ? (await prisma.halloweenSoul.count({ where: { year: ed.year, souls: { gt: souls } } })) + 1 : null;
    const served = new Set((lines as { departureStation: string; arrivalStation: string; stops: string[] }[]).flatMap((l) => [l.departureStation, ...(l.stops ?? []), l.arrivalStation]));
    mine = { souls, rank, served: [...new Set([...(haunt ? [haunt.station] : []), ...next.map((h) => h.station)])].filter((s) => served.has(s)), best };
  }

  return {
    visible: true as const,
    phase,
    year: ed.year,
    startsAt: ed.start.toISOString(),
    endsAt: ed.end.toISOString(),
    hauntMinutes: HAUNT_MINUTES,
    demand: HAUNT_DEMAND,
    nightFrom: NIGHT_SOULS_FROM,
    nightTo: NIGHT_SOULS_TO,
    haunt,
    next,
    soulsPerTrip: soulsPerTrip(now),
    tiers: TIERS.map((x) => ({ ...x, reached: mine.best >= x.souls })),
    mine,
    top: phase === "avant" ? [] : await topHunters(ed.year, 10),
    hunters: phase === "avant" ? 0 : await prisma.halloweenSoul.count({ where: { year: ed.year, souls: { gt: 0 } } }),
  };
}

/* À chaque tour de simulation : l'horaire est complété pendant l'édition. */
export async function runHalloween() {
  if (!halloweenActive()) return;
  await planHaunts();
}
