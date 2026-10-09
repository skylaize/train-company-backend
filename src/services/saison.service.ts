import { prisma } from "../prisma";
import { buildLeaderRows } from "./leaderboard.service";
import { parisDate, parisMidnight, DAY_MS } from "./time.service";

/* ============================================================
   Saisons classées (2.0). À ne pas confondre avec season.service, les
   temps forts du calendrier (Vendanges, Noël…) apparus en 1.5.

   Quatre semaines, un classement qui repart à zéro, et des divisions par
   taille : Bronze, Argent, Or, Platine. Chaque division est découpée en
   groupes de douze compagnies de valeur proche. En fin de saison, les trois
   premiers d'un groupe montent, les trois derniers descendent, et la
   première moitié du groupe gagne la livrée et le titre de la saison.

   La compagnie ne perd rien : rames, lignes, argent et grades restent.

   Les points récompensent la manière de jouer plutôt que la taille :
   un trajet bien rempli, une livraison de fret, les objectifs de la semaine.
   ============================================================ */

export const DIVISIONS = ["Bronze", "Argent", "Or", "Platine"];
export const GROUP_SIZE = 12;
export const MOVERS = 3; // montent et descendent, dans un groupe d'au moins six
export const SEASON_DAYS = 28;

export const POINTS = {
  TRIP: 1, // trajet voyageurs arrivé
  TRIP_FULL: 2, // en plus, s'il était rempli à 80 % ou plus
  FREIGHT: 5, // contrat de fret livré
};

export const SCORING = [
  { label: "Trajet voyageurs arrivé", points: "+1" },
  { label: "Trajet rempli à plus de 80 %", points: "+2" },
  { label: "Contrat de fret livré", points: "+5" },
  { label: "Objectif de la semaine", points: "+60 à +120" },
];

/* Ce que gagne la première moitié d'un groupe, selon la saison du calendrier. */
const SEASON_THEMES: Record<string, { name: string; title: string; livery: string; liveryName: string }> = {
  automne: { name: "Saison d'automne", title: "Pionnier d'automne", livery: "#b4532a", liveryName: "Feuilles d'automne" },
  hiver: { name: "Saison d'hiver", title: "Pionnier de l'hiver", livery: "#9cc7e0", liveryName: "Givre" },
  printemps: { name: "Saison de printemps", title: "Pionnier du printemps", livery: "#6fae6b", liveryName: "Prairie" },
  ete: { name: "Saison d'été", title: "Pionnier de l'été", livery: "#e8b33d", liveryName: "Blé mûr" },
};

export function themeKey(at: Date) {
  const m = parisDate(at).month;
  return m >= 9 && m <= 11 ? "automne" : m === 12 || m <= 2 ? "hiver" : m <= 5 ? "printemps" : "ete";
}

export function themeOf(season: { name: string }) {
  return Object.values(SEASON_THEMES).find((t) => season.name.startsWith(t.name)) ?? SEASON_THEMES.automne;
}

/* ---------------- objectifs de la semaine ---------------- */

export type ObjectiveKind = "TRIPS" | "RUSH_FULL" | "FREIGHT" | "FRAGILE" | "INTL" | "NIGHT" | "NEW_LINE" | "REVISE" | "FULL_TRIPS";

export const OBJECTIVES: { kind: ObjectiveKind; label: string; target: number; points: number }[] = [
  { kind: "TRIPS", label: "Faire 150 trajets voyageurs", target: 150, points: 60 },
  { kind: "FULL_TRIPS", label: "Faire 60 trajets remplis à 80 %", target: 60, points: 80 },
  { kind: "RUSH_FULL", label: "Remplir une rame jusqu'à la dernière place à la pointe", target: 1, points: 60 },
  { kind: "FREIGHT", label: "Livrer 8 contrats de fret", target: 8, points: 80 },
  { kind: "FRAGILE", label: "Livrer 3 cargaisons fragiles", target: 3, points: 100 },
  { kind: "INTL", label: "Faire 30 trajets internationaux", target: 30, points: 100 },
  { kind: "NIGHT", label: "Faire 20 trajets de nuit en couchettes", target: 20, points: 120 },
  { kind: "NEW_LINE", label: "Ouvrir une nouvelle ligne", target: 1, points: 60 },
  { kind: "REVISE", label: "Réviser 3 rames avant la panne", target: 3, points: 60 },
];

export function weekOf(season: { startsAt: Date }, now = new Date()) {
  return Math.max(0, Math.floor((now.getTime() - season.startsAt.getTime()) / (7 * DAY_MS)));
}

/* Trois objectifs par semaine, toujours les mêmes pour tout le monde, tirés
   d'après le numéro de saison et de semaine. */
export function objectivesFor(seasonNumber: number, week: number) {
  let seed = seasonNumber * 97 + week * 31 + 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pool = [...OBJECTIVES];
  const picked: typeof OBJECTIVES = [];
  while (picked.length < 3 && pool.length) picked.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return picked;
}

/* ---------------- la saison en cours ---------------- */

type SeasonRow = { id: string; number: number; name: string; startsAt: Date; endsAt: Date; endedAt: Date | null };
let current: SeasonRow | null = null;
let currentAt = 0;

export async function currentSeason(): Promise<SeasonRow | null> {
  if (current && Date.now() - currentAt < 60_000) return current;
  current = (await prisma.season.findFirst({ where: { endedAt: null }, orderBy: { number: "desc" } })) as SeasonRow | null;
  currentAt = Date.now();
  return current;
}

/* Fin de saison : le lundi à 0 h (heure de Paris) qui suit les 28 jours. */
function seasonEnd(startsAt: Date) {
  const d = parisDate(new Date(startsAt.getTime() + SEASON_DAYS * DAY_MS));
  const daysToMonday = (7 - d.weekday) % 7;
  return parisMidnight(d.year, d.month, d.day + daysToMonday);
}

/* Compagnies actives : un mouvement de trésorerie dans les trois derniers jours.
   Les autres entrent dans la saison à leur premier point. */
async function activeCompanyIds() {
  const rows = (await (prisma.transaction.groupBy as any)({
    by: ["companyId"],
    where: { createdAt: { gte: new Date(Date.now() - 3 * DAY_MS) } },
  })) as { companyId: string | null }[];
  return new Set(rows.map((r) => r.companyId).filter(Boolean) as string[]);
}

export async function startSeason(number: number, startsAt: Date) {
  const theme = SEASON_THEMES[themeKey(startsAt)];
  const season = (await prisma.season.create({
    data: { number, name: `${theme.name}`, startsAt, endsAt: seasonEnd(startsAt) },
  })) as SeasonRow;
  current = season;
  currentAt = Date.now();

  const rows = await buildLeaderRows();
  const active = await activeCompanyIds();
  const companies = (await prisma.company.findMany({ select: { id: true, division: true } })) as { id: string; division: number }[];
  const worth = new Map(rows.map((r) => [r.id, r.valeur]));
  const divisionOf = new Map(companies.map((c) => [c.id, c.division]));
  const seeded = companies.filter((c) => active.has(c.id)).sort((a, b) => (worth.get(b.id) ?? 0) - (worth.get(a.id) ?? 0));

  // première saison : divisions d'après la valeur (5 % Platine, 15 % Or, 30 % Argent, le reste Bronze)
  if (number === 1) {
    const n = seeded.length;
    for (const [i, c] of seeded.entries()) {
      const pct = n ? i / n : 1;
      const div = pct < 0.05 ? 3 : pct < 0.2 ? 2 : pct < 0.5 ? 1 : 0;
      divisionOf.set(c.id, div);
    }
    await prisma.$transaction(
      seeded.map((c) => prisma.company.update({ where: { id: c.id }, data: { division: divisionOf.get(c.id) ?? 0 } }))
    );
  }

  const data: { seasonId: string; companyId: string; division: number; groupNo: number }[] = [];
  for (let div = 0; div < DIVISIONS.length; div++) {
    const inDiv = seeded.filter((c) => (divisionOf.get(c.id) ?? 0) === div);
    inDiv.forEach((c, i) => data.push({ seasonId: season.id, companyId: c.id, division: div, groupNo: Math.floor(i / GROUP_SIZE) + 1 }));
  }
  if (data.length) await prisma.seasonEntry.createMany({ data, skipDuplicates: true });
  return season;
}

/* Une compagnie qui arrive en cours de saison rejoint le dernier groupe non
   complet de sa division, ou en ouvre un nouveau. */
export async function ensureEntry(seasonId: string, companyId: string) {
  const existing = await prisma.seasonEntry.findUnique({ where: { seasonId_companyId: { seasonId, companyId } } });
  if (existing) return existing;
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { division: true } });
  const division = company?.division ?? 0;
  const groups = (await (prisma.seasonEntry.groupBy as any)({
    by: ["groupNo"],
    where: { seasonId, division },
    _count: { _all: true },
    orderBy: { groupNo: "asc" },
  })) as { groupNo: number; _count: { _all: number } }[];
  const open = groups.find((g) => g._count._all < GROUP_SIZE);
  const groupNo = open ? open.groupNo : (groups.at(-1)?.groupNo ?? 0) + 1;
  try {
    return await prisma.seasonEntry.create({ data: { seasonId, companyId, division, groupNo } });
  } catch {
    // deux appels simultanés : l'autre a déjà créé la place
    return prisma.seasonEntry.findUnique({ where: { seasonId_companyId: { seasonId, companyId } } });
  }
}

/* ---------------- points et objectifs, groupés par tour ---------------- */

const pendingPoints = new Map<string, number>();
const knownEntries = new Set<string>();
const pendingEvents = new Map<string, number>(); // `${companyId}|${kind}`

export function addSeasonPoints(companyId: string, n: number) {
  if (n > 0) pendingPoints.set(companyId, (pendingPoints.get(companyId) ?? 0) + n);
}

export function seasonEvent(companyId: string, kind: ObjectiveKind, amount = 1) {
  const key = `${companyId}|${kind}`;
  pendingEvents.set(key, (pendingEvents.get(key) ?? 0) + amount);
}

/* Appelé à la fin de chaque tour de simulation : une écriture par compagnie,
   plutôt qu'une par trajet. */
export async function flushSeason(now = new Date()) {
  if (pendingPoints.size === 0 && pendingEvents.size === 0) return;
  const season = await currentSeason();
  const points = new Map(pendingPoints);
  const events = new Map(pendingEvents);
  pendingPoints.clear();
  pendingEvents.clear();
  if (!season || now >= season.endsAt) return;

  const week = weekOf(season, now);
  const objectives = objectivesFor(season.number, week);
  for (const [key, amount] of events) {
    const [companyId, kind] = key.split("|");
    const obj = objectives.find((o) => o.kind === kind);
    if (!obj) continue;
    const row = await prisma.seasonObjectiveProgress.upsert({
      where: { seasonId_week_kind_companyId: { seasonId: season.id, week, kind, companyId } },
      create: { seasonId: season.id, week, kind, companyId, progress: amount },
      update: { progress: { increment: amount } },
    });
    if (!row.doneAt && row.progress >= obj.target) {
      // une seule fois : la condition sur doneAt évite de payer deux fois
      const done = await prisma.seasonObjectiveProgress.updateMany({ where: { id: row.id, doneAt: null }, data: { doneAt: now } });
      if (done.count) points.set(companyId, (points.get(companyId) ?? 0) + obj.points);
    }
  }

  for (const [companyId, n] of points) {
    // une place connue n'est pas relue à chaque tour
    const key = `${season.id}|${companyId}`;
    if (!knownEntries.has(key)) {
      await ensureEntry(season.id, companyId);
      knownEntries.add(key);
    }
    await prisma.seasonEntry.update({
      where: { seasonId_companyId: { seasonId: season.id, companyId } },
      data: { points: { increment: n } },
    });
  }
}

/* ---------------- fin de saison ---------------- */

export async function finalizeSeason(season: SeasonRow) {
  const entries = (await prisma.seasonEntry.findMany({ where: { seasonId: season.id } })) as {
    id: string; companyId: string; division: number; groupNo: number; points: number; joinedAt: Date;
  }[];
  const groups = new Map<string, typeof entries>();
  for (const e of entries) {
    const k = `${e.division}-${e.groupNo}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const ops: any[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.points - a.points || new Date(a.joinedAt ?? 0).getTime() - new Date(b.joinedAt ?? 0).getTime());
    const size = list.length;
    const half = Math.ceil(size / 2);
    list.forEach((e, i) => {
      const rank = i + 1;
      let outcome = "MAINTIEN";
      let division = e.division;
      if (size >= 6 && rank <= MOVERS && e.division < DIVISIONS.length - 1 && e.points > 0) {
        outcome = "MONTEE";
        division++;
      } else if (size >= 6 && rank > size - MOVERS && e.division > 0) {
        outcome = "DESCENTE";
        division--;
      }
      ops.push(prisma.seasonEntry.update({ where: { id: e.id }, data: { finalRank: rank, outcome, rewarded: rank <= half && e.points > 0 } }));
      ops.push(prisma.company.update({ where: { id: e.companyId }, data: { division } }));
    });
  }
  for (let i = 0; i < ops.length; i += 200) await prisma.$transaction(ops.slice(i, i + 200));
  await prisma.season.update({ where: { id: season.id }, data: { endedAt: new Date() } });
  current = null;
}

/* ---------------- le tour de saison ---------------- */

let lastSnapshotDay = "";

/* Appelé régulièrement : ouvre la première saison, clôt celle qui se
   termine et ouvre la suivante, et note chaque nuit le rang de chacun pour
   la flèche d'évolution. Renvoie la saison close, s'il y en a une. */
export async function runSeasons(now = new Date()) {
  // SEASONS_START_AT (date ISO) : la première saison n'ouvre pas avant cette date
  const startAt = process.env.SEASONS_START_AT ? new Date(process.env.SEASONS_START_AT) : null;
  if (startAt && !Number.isNaN(startAt.getTime()) && now < startAt) return null;
  let season = await currentSeason();
  let closed: SeasonRow | null = null;
  if (!season) {
    const last = (await prisma.season.findFirst({ orderBy: { number: "desc" } })) as SeasonRow | null;
    season = await startSeason((last?.number ?? 0) + 1, now);
  } else if (now >= season.endsAt) {
    await finalizeSeason(season);
    closed = season;
    season = await startSeason(season.number + 1, season.endsAt);
  }

  const d = parisDate(now);
  const day = `${d.year}-${d.month}-${d.day}`;
  if (day !== lastSnapshotDay) {
    lastSnapshotDay = day;
    await snapshotRanks(season.id);
  }
  return closed;
}

async function snapshotRanks(seasonId: string) {
  const entries = (await prisma.seasonEntry.findMany({
    where: { seasonId },
    select: { id: true, division: true, groupNo: true, points: true },
    orderBy: { points: "desc" },
  })) as { id: string; division: number; groupNo: number; points: number }[];
  const counters = new Map<string, number>();
  const ops = entries.map((e) => {
    const k = `${e.division}-${e.groupNo}`;
    const r = (counters.get(k) ?? 0) + 1;
    counters.set(k, r);
    return prisma.seasonEntry.update({ where: { id: e.id }, data: { rankYesterday: r } });
  });
  for (let i = 0; i < ops.length; i += 200) await prisma.$transaction(ops.slice(i, i + 200));
}

/* ---------------- récompenses ---------------- */

/* Titres et livrées gagnés lors des saisons passées, pour la boutique. */
export async function seasonUnlocks(companyId: string) {
  const won = (await prisma.seasonEntry.findMany({ where: { companyId, rewarded: true }, select: { seasonId: true } })) as { seasonId: string }[];
  if (won.length === 0) return { titles: [] as string[], liveries: [] as string[] };
  const seasons = (await prisma.season.findMany({ where: { id: { in: won.map((w) => w.seasonId) } }, select: { name: true } })) as { name: string }[];
  const themes = seasons.map((s) => themeOf(s));
  return { titles: [...new Set(themes.map((t) => t.title))], liveries: [...new Set(themes.map((t) => t.livery))] };
}

/* ---------------- la vue du joueur ---------------- */

export async function seasonView(companyId: string, now = new Date()) {
  const season = await currentSeason();
  if (!season) return { season: null };
  const me = await ensureEntry(season.id, companyId);
  if (!me) return { season: null };

  const groupRows = (await prisma.seasonEntry.findMany({
    where: { seasonId: season.id, division: me.division, groupNo: me.groupNo },
    orderBy: [{ points: "desc" }, { joinedAt: "asc" }],
  })) as { companyId: string; points: number; rankYesterday: number | null }[];
  const companies = (await prisma.company.findMany({
    where: { id: { in: groupRows.map((r) => r.companyId) } },
    select: { id: true, name: true, liveryColor: true },
  })) as { id: string; name: string; liveryColor: string }[];
  const byId = new Map(companies.map((c) => [c.id, c]));
  const group = groupRows.map((r, i) => ({
    rank: i + 1,
    companyId: r.companyId,
    name: byId.get(r.companyId)?.name ?? "—",
    liveryColor: byId.get(r.companyId)?.liveryColor ?? "#94a3b8",
    points: r.points,
    trend: r.rankYesterday ? r.rankYesterday - (i + 1) : 0,
    isMe: r.companyId === companyId,
  }));
  const myRank = group.find((g) => g.isMe)?.rank ?? group.length;

  const counts = (await (prisma.seasonEntry.groupBy as any)({
    by: ["division"],
    where: { seasonId: season.id },
    _count: { _all: true },
  })) as { division: number; _count: { _all: number } }[];
  const divisions = DIVISIONS.map((name, id) => ({ id, name, count: counts.find((c) => c.division === id)?._count._all ?? 0 }));

  const week = Math.min(3, weekOf(season, now));
  const progress = (await prisma.seasonObjectiveProgress.findMany({
    where: { seasonId: season.id, week, companyId },
  })) as { kind: string; progress: number; doneAt: Date | null }[];
  const objectives = objectivesFor(season.number, week).map((o) => {
    const p = progress.find((x) => x.kind === o.kind);
    return { kind: o.kind, label: o.label, target: o.target, points: o.points, progress: Math.min(o.target, p?.progress ?? 0), done: Boolean(p?.doneAt) };
  });
  const weekEndsAt = new Date(Math.min(season.endsAt.getTime(), season.startsAt.getTime() + (week + 1) * 7 * DAY_MS));

  const previous = (await prisma.season.findFirst({ where: { number: season.number - 1 } })) as SeasonRow | null;
  const last = previous
    ? ((await prisma.seasonEntry.findUnique({ where: { seasonId_companyId: { seasonId: previous.id, companyId } } })) as {
        finalRank: number | null; outcome: string | null; division: number; rewarded: boolean;
      } | null)
    : null;

  const theme = themeOf(season);
  return {
    season: {
      id: season.id,
      number: season.number,
      name: season.name,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
      week: week + 1,
      weeks: Math.ceil((season.endsAt.getTime() - season.startsAt.getTime()) / (7 * DAY_MS)),
      weekEndsAt,
    },
    me: { division: me.division, divisionName: DIVISIONS[me.division], groupNo: me.groupNo, points: me.points, rank: myRank, groupSize: group.length },
    group,
    movers: group.length >= 6 ? MOVERS : 0,
    divisions,
    objectives,
    reward: { title: theme.title, livery: theme.livery, liveryName: theme.liveryName, cut: Math.ceil(group.length / 2) },
    scoring: SCORING,
    last: last && previous ? { name: previous.name, finalRank: last.finalRank, outcome: last.outcome, rewarded: last.rewarded } : null,
  };
}

/* Une notification à chacun, en fin de saison : son rang et ce qui change. */
export async function notifySeasonEnd(seasonId: string) {
  const { sendToCompany } = await import("./push.service");
  const entries = (await prisma.seasonEntry.findMany({ where: { seasonId, points: { gt: 0 } } })) as {
    companyId: string; finalRank: number | null; outcome: string | null; division: number; rewarded: boolean;
  }[];
  for (const e of entries) {
    const div = DIVISIONS[e.division];
    const move = e.outcome === "MONTEE" ? `, vous montez en ${DIVISIONS[e.division + 1]}` : e.outcome === "DESCENTE" ? `, vous redescendez en ${DIVISIONS[e.division - 1]}` : "";
    await sendToCompany(e.companyId, {
      title: "Fin de saison",
      body: `${e.finalRank}e de votre groupe ${div}${move}.${e.rewarded ? " La livrée et le titre de la saison sont à vous." : ""} Une nouvelle saison commence.`,
      url: "/dashboard",
      tag: "saison",
    }).catch(() => {});
  }
}
