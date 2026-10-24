import { prisma } from "../prisma";
import { allStationCounts } from "./hub.service";
import { startOfParisWeek, DAY_MS } from "./time.service";

/* ============================================================
   Régions d'alliance (2.3).

   La France est découpée en ses treize régions, plus une zone « Étranger »
   pour les gares hors de France. Chaque lundi à 0 h (heure de Paris), une
   région revient à l'alliance qui y dessert le plus de gares, avec au moins
   une rame sur la ligne. En cas d'égalité, c'est le nombre de trajets faits
   dans la région pendant la semaine écoulée qui départage, puis l'ancienneté
   de l'alliance.

   Le bonus : +5 % de recette sur les trajets qui passent par une région que
   tient l'alliance. Deux garde-fous contre la boule de neige :
   - au-delà de trois régions, le bonus se partage (quatre régions : 3,75 %
     chacune) ;
   - une alliance d'un ou deux membres n'en tire presque rien (1 % et 2,5 %).

   La région se lit à la semaine : on la gagne, on la défend, on la perd.
   ============================================================ */

export interface Region {
  id: string;
  name: string;
  stations: string[];
  dlc?: string; // la Corse ne se joue qu'avec l'extension
}

export const REGIONS: Region[] = [
  { id: "hdf", name: "Hauts-de-France", stations: ["Lille", "Amiens"] },
  { id: "normandie", name: "Normandie", stations: ["Le Havre", "Rouen", "Caen"] },
  { id: "idf", name: "Île-de-France", stations: ["Paris"] },
  { id: "grand-est", name: "Grand Est", stations: ["Metz", "Nancy", "Strasbourg", "Mulhouse", "Reims", "Troyes"] },
  { id: "bretagne", name: "Bretagne", stations: ["Rennes", "Brest"] },
  { id: "pdl", name: "Pays de la Loire", stations: ["Nantes", "Le Mans", "Angers"] },
  { id: "cvl", name: "Centre-Val de Loire", stations: ["Chartres", "Orléans", "Tours"] },
  { id: "bfc", name: "Bourgogne-Franche-Comté", stations: ["Dijon", "Besançon"] },
  { id: "nouvelle-aquitaine", name: "Nouvelle-Aquitaine", stations: ["Bordeaux", "Poitiers", "La Rochelle", "Limoges", "Pau", "Bayonne"] },
  { id: "occitanie", name: "Occitanie", stations: ["Toulouse", "Montpellier", "Perpignan", "Font-Romeu"] },
  { id: "ara", name: "Auvergne-Rhône-Alpes", stations: ["Lyon", "Grenoble", "Clermont-Ferrand", "Saint-Étienne", "Chamonix", "Bourg-Saint-Maurice"] },
  { id: "paca", name: "Provence-Alpes-Côte d'Azur", stations: ["Marseille", "Avignon", "Nice", "Briançon"] },
  { id: "corse", name: "Corse", stations: ["Bastia", "Corte", "Ajaccio", "Calvi", "L'Île-Rousse"], dlc: "dlc-corse" },
  { id: "etranger", name: "Étranger", stations: ["Londres", "Bruxelles", "Francfort", "Genève", "Milan", "Barcelone", "Turin", "Zurich"] },
];

export const REGION_OF: Record<string, string> = Object.fromEntries(REGIONS.flatMap((r) => r.stations.map((s) => [s, r.id])));

export const REGION_BONUS = 0.05;
export const REGION_SPREAD_FROM = 3; // au-delà, le bonus se partage

/* Ce que rapporte une région à une alliance qui en tient `held`, avec `members` membres. */
export function regionBonusRate(held: number, members: number) {
  if (held <= 0) return 0;
  const size = members >= 3 ? 1 : members === 2 ? 0.5 : 0.2;
  const spread = held <= REGION_SPREAD_FROM ? 1 : REGION_SPREAD_FROM / held;
  return REGION_BONUS * size * spread;
}

/* ---------------- le bonus, pour la simulation ---------------- */

export type RegionBonuses = Map<string, { regions: Set<string>; rate: number }>;
let bonusCache: { at: number; week: number; map: RegionBonuses } | null = null;

export function invalidateRegionBonuses() {
  bonusCache = null;
}

/* Compagnie → régions tenues par son alliance et taux du bonus. Relu au plus
   toutes les minutes, et à chaque changement de semaine. */
export async function regionBonusMap(now = new Date()): Promise<RegionBonuses> {
  const week = startOfParisWeek(now).getTime();
  if (bonusCache && bonusCache.week === week && Date.now() - bonusCache.at < 60_000) return bonusCache.map;
  const rows = (await prisma.regionControl.findMany({
    where: { weekStart: new Date(week), allianceId: { not: null } },
    select: { region: true, allianceId: true },
  })) as { region: string; allianceId: string }[];
  const map: RegionBonuses = new Map();
  if (rows.length) {
    const held = new Map<string, Set<string>>();
    for (const r of rows) held.set(r.allianceId, (held.get(r.allianceId) ?? new Set()).add(r.region));
    const members = (await prisma.allianceMember.findMany({
      where: { allianceId: { in: [...held.keys()] } },
      select: { allianceId: true, companyId: true },
    })) as { allianceId: string; companyId: string }[];
    const size = new Map<string, number>();
    for (const m of members) size.set(m.allianceId, (size.get(m.allianceId) ?? 0) + 1);
    for (const m of members) {
      const regions = held.get(m.allianceId)!;
      map.set(m.companyId, { regions, rate: regionBonusRate(regions.size, size.get(m.allianceId) ?? 1) });
    }
  }
  bonusCache = { at: Date.now(), week, map };
  return map;
}

/* Le multiplicateur d'un trajet : une fois, si l'itinéraire passe par une région tenue. */
export function regionMultiplier(map: RegionBonuses | undefined, companyId: string, route: string[]) {
  const mine = map?.get(companyId);
  if (!mine || mine.rate <= 0) return 1;
  return route.some((s) => mine.regions.has(REGION_OF[s])) ? 1 + mine.rate : 1;
}

/* ---------------- l'état des régions ---------------- */

type Standing = { allianceId: string; stations: number; trips: number };

/* Gares desservies par chaque alliance dans chaque région, aujourd'hui. */
async function liveStations() {
  const [members, counts] = await Promise.all([
    prisma.allianceMember.findMany({ select: { allianceId: true, companyId: true } }) as Promise<{ allianceId: string; companyId: string }[]>,
    allStationCounts(),
  ]);
  const byAlliance = new Map<string, Set<string>>();
  for (const m of members) {
    const served = (counts as Map<string, Map<string, number>>).get(m.companyId);
    if (!served) continue;
    const set = byAlliance.get(m.allianceId) ?? new Set<string>();
    for (const [st, n] of served) if (n > 0) set.add(st);
    byAlliance.set(m.allianceId, set);
  }
  // région → alliance → gares
  const out = new Map<string, Map<string, number>>();
  for (const [allianceId, stations] of byAlliance) {
    for (const st of stations) {
      const region = REGION_OF[st];
      if (!region) continue;
      const m = out.get(region) ?? new Map<string, number>();
      m.set(allianceId, (m.get(allianceId) ?? 0) + 1);
      out.set(region, m);
    }
  }
  return { out, members };
}

/* Trajets voyageurs de la semaine écoulée, par alliance et par région. */
async function tripsLastWeek(members: { allianceId: string; companyId: string }[], weekStart: Date) {
  const allianceOf = new Map(members.map((m) => [m.companyId, m.allianceId]));
  const out = new Map<string, Map<string, number>>();
  if (members.length === 0) return out;
  const grouped = (await (prisma.transaction.groupBy as any)({
    by: ["lineId", "companyId"],
    where: { type: "REVENU_LIGNE", companyId: { in: [...allianceOf.keys()] }, createdAt: { gte: new Date(weekStart.getTime() - 7 * DAY_MS), lt: weekStart } },
    _count: { _all: true },
  })) as { lineId: string | null; companyId: string; _count: { _all: number } }[];
  const lineIds = grouped.map((g) => g.lineId).filter(Boolean) as string[];
  const lines = (await prisma.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, departureStation: true, arrivalStation: true, stops: true } })) as {
    id: string; departureStation: string; arrivalStation: string; stops: string[];
  }[];
  const routeOf = new Map(lines.map((l) => [l.id, [l.departureStation, ...(l.stops ?? []), l.arrivalStation]]));
  for (const g of grouped) {
    const allianceId = allianceOf.get(g.companyId);
    const route = g.lineId ? routeOf.get(g.lineId) : undefined;
    if (!allianceId || !route) continue;
    for (const region of new Set(route.map((s) => REGION_OF[s]).filter(Boolean))) {
      const m = out.get(region) ?? new Map<string, number>();
      m.set(allianceId, (m.get(allianceId) ?? 0) + g._count._all);
      out.set(region, m);
    }
  }
  return out;
}

function winnerOf(standings: Standing[], founded: Map<string, number>) {
  const ranked = standings
    .filter((s) => s.stations > 0)
    .sort((a, b) => b.stations - a.stations || b.trips - a.trips || (founded.get(a.allianceId) ?? 0) - (founded.get(b.allianceId) ?? 0));
  return ranked[0] ?? null;
}

export type RegionChange = { region: string; name: string; from: string | null; to: string | null };

/* Le passage du lundi : une fois par semaine, à la première occasion. Renvoie
   les changements de main, pour la Gazette, Discord et les notifications. */
export async function runRegions(now = new Date()): Promise<RegionChange[] | null> {
  const weekStart = startOfParisWeek(now);
  const already = await prisma.regionControl.count({ where: { weekStart } });
  if (already > 0) return null;

  const { out: stations, members } = await liveStations();
  const trips = await tripsLastWeek(members, weekStart);
  const alliances = (await prisma.alliance.findMany({ select: { id: true, createdAt: true } })) as { id: string; createdAt: Date }[];
  const founded = new Map(alliances.map((a) => [a.id, a.createdAt.getTime()]));
  const previousWeek = new Date(weekStart.getTime() - 7 * DAY_MS);
  const previous = (await prisma.regionControl.findMany({ where: { weekStart: previousWeek } })) as { region: string; allianceId: string | null; since: Date | null }[];
  const prevBy = new Map(previous.map((p) => [p.region, p]));

  const rows = REGIONS.map((r) => {
    const st = stations.get(r.id) ?? new Map<string, number>();
    const tr = trips.get(r.id) ?? new Map<string, number>();
    const ids = new Set([...st.keys(), ...tr.keys()]);
    const standings = [...ids].map((allianceId) => ({ allianceId, stations: st.get(allianceId) ?? 0, trips: tr.get(allianceId) ?? 0 }));
    const win = winnerOf(standings, founded);
    const prev = prevBy.get(r.id);
    const kept = Boolean(win && prev?.allianceId === win.allianceId);
    return {
      weekStart,
      region: r.id,
      allianceId: win?.allianceId ?? null,
      stations: win?.stations ?? 0,
      trips: win?.trips ?? 0,
      since: win ? (kept ? prev?.since ?? weekStart : weekStart) : null,
      previousId: prev?.allianceId ?? null,
    };
  });
  const created = await prisma.regionControl.createMany({ data: rows, skipDuplicates: true });
  invalidateRegionBonuses();
  // un autre serveur a fait le passage en même temps : c'est lui qui annonce
  if (created.count < rows.length) return null;

  const names = new Map(
    ((await prisma.alliance.findMany({ select: { id: true, name: true } })) as { id: string; name: string }[]).map((a) => [a.id, a.name])
  );
  return rows
    .filter((r) => r.allianceId !== r.previousId && (previous.length > 0 || r.allianceId))
    .map((r) => ({
      region: r.region,
      name: REGIONS.find((x) => x.id === r.region)!.name,
      from: r.previousId ? names.get(r.previousId) ?? null : null,
      to: r.allianceId ? names.get(r.allianceId) ?? null : null,
    }));
}

/* Ce que montre la page Alliance : qui tient chaque région cette semaine, et
   où en est la course pour lundi prochain (gares desservies aujourd'hui). */
export async function regionsView(allianceId: string | null, ownsCorsica: boolean, now = new Date()) {
  const weekStart = startOfParisWeek(now);
  const [rows, live, alliances, memberCount] = await Promise.all([
    prisma.regionControl.findMany({ where: { weekStart } }) as Promise<{ region: string; allianceId: string | null; stations: number; trips: number; since: Date | null; previousId: string | null }[]>,
    liveStations(),
    prisma.alliance.findMany({ select: { id: true, name: true, color: true } }) as Promise<{ id: string; name: string; color: string }[]>,
    allianceId ? prisma.allianceMember.count({ where: { allianceId } }) : Promise.resolve(0),
  ]);
  const byId = new Map(alliances.map((a) => [a.id, a]));
  const heldByMe = rows.filter((r) => r.allianceId && r.allianceId === allianceId).length;
  const rate = allianceId ? regionBonusRate(heldByMe, memberCount) : 0;
  return {
    weekStart,
    nextAt: new Date(weekStart.getTime() + 7 * DAY_MS),
    bonus: Math.round(rate * 1000) / 10, // en %, pour mon alliance
    rules: { base: REGION_BONUS * 100, spreadFrom: REGION_SPREAD_FROM },
    regions: REGIONS.map((r) => {
      const row = rows.find((x) => x.region === r.id);
      const holder = row?.allianceId ? byId.get(row.allianceId) ?? null : null;
      const race = [...(live.out.get(r.id) ?? new Map<string, number>()).entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, n]) => ({ allianceId: id, name: byId.get(id)?.name ?? "—", color: byId.get(id)?.color ?? "#94a3b8", stations: n, mine: id === allianceId }));
      const mineNow = allianceId ? live.out.get(r.id)?.get(allianceId) ?? 0 : 0;
      const weeks = row?.since ? Math.round((weekStart.getTime() - row.since.getTime()) / (7 * DAY_MS)) + 1 : 0;
      return {
        id: r.id,
        name: r.name,
        stations: r.stations,
        locked: Boolean(r.dlc && !ownsCorsica),
        holder: holder ? { id: holder.id, name: holder.name, color: holder.color, mine: holder.id === allianceId, stations: row!.stations, weeks } : null,
        mine: mineNow,
        race,
      };
    }),
  };
}

/* Pour la Gazette : les changements de main de la semaine, si le passage date de moins de 24 h. */
export async function recentRegionChanges(now = new Date()) {
  const weekStart = startOfParisWeek(now);
  if (now.getTime() - weekStart.getTime() > DAY_MS) return [];
  const rows = (await prisma.regionControl.findMany({ where: { weekStart } })) as { region: string; allianceId: string | null; previousId: string | null }[];
  const changed = rows.filter((r) => r.allianceId && r.allianceId !== r.previousId);
  if (!changed.length) return [];
  const names = new Map(
    ((await prisma.alliance.findMany({ where: { id: { in: changed.flatMap((r) => [r.allianceId!, r.previousId].filter(Boolean) as string[]) } }, select: { id: true, name: true } })) as { id: string; name: string }[]).map((a) => [a.id, a.name])
  );
  return changed.map((r) => ({
    name: REGIONS.find((x) => x.id === r.region)?.name ?? r.region,
    to: names.get(r.allianceId!) ?? "Une alliance",
    from: r.previousId ? names.get(r.previousId) ?? null : null,
  }));
}
