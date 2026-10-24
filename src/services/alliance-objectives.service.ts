import { prisma } from "../prisma";
import { allStationCounts } from "./hub.service";
import { addSeasonPoints } from "./saison.service";
import { startOfParisWeek, DAY_MS } from "./time.service";

/* ============================================================
   Objectifs d'alliance de la semaine (2.3).

   Trois objectifs par alliance, tirés le lundi à 0 h (heure de Paris), au
   rythme des saisons. Les cibles suivent la taille de l'alliance ET ce
   qu'elle a réellement fait la semaine précédente : une alliance de deux
   joueurs a autant de chances de tout remplir qu'une alliance complète.

   La progression est recalculée depuis la base (trajets, fret, recettes des
   membres depuis le lundi) : rien ne se perd pendant un redéploiement. Chaque
   objectif rempli paie des pièces et des points de saison à chaque membre
   qui y a contribué ; les trois remplis paient un bonus en plus.

   Un membre arrivé en cours de semaine compte à partir de son arrivée. Un
   membre qui part emporte sa part : un objectif peut reculer, mais un
   objectif rempli le reste.
   ============================================================ */

export type AllianceObjectiveKind = "TRIPS" | "REVENUE" | "FREIGHT" | "NIGHT" | "INTL" | "SHARED";

export interface AllianceObjective {
  kind: AllianceObjectiveKind;
  label: string;
  target: number;
  points: number; // points de saison, à chaque contributeur
  coins: number; // pièces, à chaque contributeur
}

export const ALL_DONE_POINTS = 60;
export const ALL_DONE_COINS = 800;
const POINTS = 40;

const fmt = (n: number) => n.toLocaleString("fr-FR").replace(/ | /g, " ");
const round = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);

/* Les cibles : au moins un plancher par membre, sinon un peu plus que la semaine passée. */
function buildObjective(kind: AllianceObjectiveKind, members: number, lastWeek: number): AllianceObjective {
  switch (kind) {
    case "TRIPS": {
      const target = Math.max(40 * members, round(lastWeek * 1.1, 10));
      return { kind, label: `Faire ${fmt(target)} trajets voyageurs à vous tous`, target, points: POINTS, coins: 400 };
    }
    case "REVENUE": {
      const target = Math.max(5000 * members, round(lastWeek * 1.1, 1000));
      return { kind, label: `Encaisser ${fmt(target)} pi. de recettes voyageurs`, target, points: POINTS, coins: 500 };
    }
    case "FREIGHT": {
      const target = Math.max(3 * members, Math.ceil(lastWeek * 1.1));
      return { kind, label: `Livrer ${fmt(target)} contrats de fret`, target, points: POINTS, coins: 400 };
    }
    case "NIGHT": {
      const target = Math.max(5, Math.ceil(lastWeek * 1.1));
      return { kind, label: `Faire ${fmt(target)} trajets de nuit`, target, points: POINTS, coins: 500 };
    }
    case "INTL": {
      const target = Math.max(5, Math.ceil(lastWeek * 1.1));
      return { kind, label: `Faire ${fmt(target)} trajets internationaux`, target, points: POINTS, coins: 500 };
    }
    case "SHARED": {
      const target = members <= 2 ? 1 : 2;
      return { kind, label: target > 1 ? `Ouvrir ${target} nouvelles gares communes` : "Ouvrir une nouvelle gare commune", target, points: POINTS, coins: 600 };
    }
  }
}

/* ---------------- les mesures ---------------- */

type Window = { companyId: string; from: Date };

/* Trajets, recettes, fret, nuit, international : une requête par mesure pour
   toute l'alliance, chaque membre compté depuis max(lundi, son arrivée). */
async function measure(kind: AllianceObjectiveKind, windows: Window[], until: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (kind === "SHARED" || windows.length === 0) return out;
  /* Un agrégat par membre, depuis son propre point de départ : l'index
     (companyId, type, createdAt) le rend léger, même pour une alliance qui
     fait des dizaines de milliers de trajets par semaine. */
  for (const w of windows) {
    const where: Record<string, unknown> = { companyId: w.companyId, createdAt: { gte: w.from, lt: until } };
    if (kind === "TRIPS" || kind === "REVENUE") where.type = "REVENU_LIGNE";
    if (kind === "NIGHT") Object.assign(where, { type: "REVENU_LIGNE", description: { startsWith: "Trajet de nuit" } });
    if (kind === "FREIGHT") Object.assign(where, { type: "FRET", amount: { gt: 0 }, description: { startsWith: "Livraison" } });
    if (kind === "INTL") where.type = "PEAGE";
    const agg = (await prisma.transaction.aggregate({ where, _count: { _all: true }, _sum: { amount: true } })) as { _count: { _all: number }; _sum: { amount: number | null } };
    const v = kind === "REVENUE" ? agg._sum.amount ?? 0 : agg._count._all;
    if (v > 0) out.set(w.companyId, v);
  }
  return out;
}

/* Gares desservies par au moins deux membres, avec une rame. */
async function sharedStations(memberIds: string[]) {
  const counts = (await allStationCounts()) as Map<string, Map<string, number>>;
  const served = new Map<string, Set<string>>();
  for (const id of memberIds) for (const [st, n] of counts.get(id) ?? new Map()) if (n > 0) served.set(st, (served.get(st) ?? new Set()).add(id));
  return [...served.entries()].filter(([, s]) => s.size >= 2);
}

/* ---------------- le tirage ---------------- */

function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h >>>= 0) % 100000) / 100000;
  };
}

async function drawWeek(allianceId: string, weekStart: Date) {
  const members = (await prisma.allianceMember.findMany({ where: { allianceId }, select: { companyId: true } })) as { companyId: string }[];
  if (members.length === 0) return null;
  const ids = members.map((m) => m.companyId);
  const lastWindows = ids.map((companyId) => ({ companyId, from: new Date(weekStart.getTime() - 7 * DAY_MS) }));
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const [trips, revenue, freight, night, intl, shared] = await Promise.all([
    measure("TRIPS", lastWindows, weekStart).then(sum),
    measure("REVENUE", lastWindows, weekStart).then(sum),
    measure("FREIGHT", lastWindows, weekStart).then(sum),
    measure("NIGHT", lastWindows, weekStart).then(sum),
    measure("INTL", lastWindows, weekStart).then(sum),
    sharedStations(ids),
  ]);
  const last: Record<AllianceObjectiveKind, number> = { TRIPS: trips, REVENUE: revenue, FREIGHT: freight, NIGHT: night, INTL: intl, SHARED: 0 };
  /* Le tirage : toujours un objectif voyageurs (trajets ou recettes), puis deux
     autres parmi ceux qui ont du sens pour cette alliance (pas de trajets de
     nuit à qui n'a jamais roulé de nuit). */
  const rnd = seeded(`${allianceId}|${weekStart.toISOString()}`);
  const pick = <T,>(xs: T[]) => xs.splice(Math.floor(rnd() * xs.length), 1)[0];
  const first: AllianceObjectiveKind[] = ["TRIPS", "REVENUE"];
  const pool: AllianceObjectiveKind[] = ["FREIGHT", "SHARED"];
  if (night > 0) pool.push("NIGHT");
  if (intl > 0) pool.push("INTL");
  const a = pick(first);
  pool.push(...first); // l'autre objectif voyageurs reste possible
  const kinds = [a, pick(pool), pick(pool)];
  const objectives = kinds.map((k) => buildObjective(k, ids.length, last[k]));
  try {
    return await prisma.allianceWeek.create({
      data: { allianceId, weekStart, objectives: objectives as any, baseline: { shared: shared.length } as any },
    });
  } catch {
    // tiré en même temps par un autre serveur
    return prisma.allianceWeek.findUnique({ where: { allianceId_weekStart: { allianceId, weekStart } } });
  }
}

/* ---------------- le passage régulier ---------------- */

type Push = (companyId: string, title: string, body: string) => Promise<void>;
type WeekRow = { id: string; allianceId: string; weekStart: Date; objectives: any; baseline: any; progress: any; shares: any; done: any; bonusPaid: boolean };

export async function runAllianceObjectives(push: Push, now = new Date()) {
  const weekStart = startOfParisWeek(now);
  const alliances = (await prisma.alliance.findMany({ select: { id: true, name: true } })) as { id: string; name: string }[];
  for (const al of alliances) {
    let week = (await prisma.allianceWeek.findUnique({ where: { allianceId_weekStart: { allianceId: al.id, weekStart } } })) as WeekRow | null;
    if (!week) week = (await drawWeek(al.id, weekStart)) as WeekRow | null;
    if (!week) continue;
    await refreshWeek(week, al.name, push, now).catch((err) => console.error(`[alliances, objectifs] ${al.name} :`, (err as Error).message));
  }
}

async function refreshWeek(week: WeekRow, allianceName: string, push: Push, now: Date) {
  const members = (await prisma.allianceMember.findMany({ where: { allianceId: week.allianceId }, select: { companyId: true, joinedAt: true } })) as { companyId: string; joinedAt: Date }[];
  if (members.length === 0) return;
  const windows = members.map((m) => ({ companyId: m.companyId, from: new Date(Math.max(week.weekStart.getTime(), m.joinedAt.getTime())) }));
  const objectives = week.objectives as AllianceObjective[];
  const progress: Record<string, number> = { ...(week.progress ?? {}) };
  const shares: Record<string, Record<string, number>> = { ...(week.shares ?? {}) };
  const done: Record<string, string> = { ...(week.done ?? {}) };
  const newlyDone: AllianceObjective[] = [];

  for (const o of objectives) {
    if (o.kind === "SHARED") {
      const shared = await sharedStations(members.map((m) => m.companyId));
      progress.SHARED = Math.max(0, shared.length - Number(week.baseline?.shared ?? 0));
      // tous ceux qui desservent une gare commune y ont mis du leur
      const part: Record<string, number> = {};
      for (const [, set] of shared) for (const id of set) part[id] = (part[id] ?? 0) + 1;
      shares.SHARED = part;
    } else {
      const m = await measure(o.kind, windows, now);
      progress[o.kind] = [...m.values()].reduce((a, b) => a + b, 0);
      shares[o.kind] = Object.fromEntries(m);
    }
    if (!done[o.kind] && progress[o.kind] >= o.target) newlyDone.push(o);
  }

  // l'écriture d'abord, avec la garde : un objectif ne paie qu'une fois
  for (const o of newlyDone) done[o.kind] = now.toISOString();
  // la garde : si `done` a bougé entre-temps (un autre passage), on ne paie rien
  const claimed = await prisma.allianceWeek.updateMany({
    where: { id: week.id, ...(newlyDone.length ? { done: { equals: (week.done ?? {}) as any } } : {}) },
    data: { progress: progress as any, shares: shares as any, done: done as any },
  });
  if (newlyDone.length === 0 || claimed.count === 0) return;

  const ids = members.map((m) => m.companyId);
  for (const o of newlyDone) {
    const contributors = ids.filter((id) => (shares[o.kind]?.[id] ?? 0) > 0);
    await payContributors(contributors, o.coins, o.points, `Objectif d'alliance rempli : ${o.label.charAt(0).toLowerCase()}${o.label.slice(1)}`);
    await systemMessage(week.allianceId, `Objectif rempli : ${o.label.charAt(0).toLowerCase()}${o.label.slice(1)}. +${fmt(o.coins)} pi. et +${o.points} points de saison pour chaque membre qui y a contribué.`);
    for (const id of ids) await push(id, "Objectif d'alliance rempli", `${allianceName} : ${o.label.charAt(0).toLowerCase()}${o.label.slice(1)}.`).catch(() => undefined);
  }

  // les trois : le bonus, une seule fois
  if (objectives.every((o) => done[o.kind]) && !week.bonusPaid) {
    const bonus = await prisma.allianceWeek.updateMany({ where: { id: week.id, bonusPaid: false }, data: { bonusPaid: true } });
    if (bonus.count) {
      const contributors = ids.filter((id) => objectives.some((o) => (shares[o.kind]?.[id] ?? 0) > 0));
      await payContributors(contributors, ALL_DONE_COINS, ALL_DONE_POINTS, "Les trois objectifs d'alliance de la semaine remplis");
      await systemMessage(week.allianceId, `Les trois objectifs de la semaine sont remplis : +${fmt(ALL_DONE_COINS)} pi. et +${ALL_DONE_POINTS} points de saison en plus pour chaque contributeur. Bravo !`);
    }
  }
}

async function payContributors(ids: string[], coins: number, points: number, description: string) {
  for (const companyId of ids) {
    await prisma.$transaction([
      prisma.company.update({ where: { id: companyId }, data: { balance: { increment: coins } } }),
      prisma.transaction.create({ data: { companyId, type: "ALLIANCE", amount: coins, description } }),
    ]);
    addSeasonPoints(companyId, points);
  }
}

/* Un message du réseau sur le tableau d'affichage de l'alliance. */
export const SYSTEM_AUTHOR = "RESEAU";
async function systemMessage(allianceId: string, text: string) {
  await prisma.allianceMessage.create({ data: { allianceId, companyId: SYSTEM_AUTHOR, text } }).catch(() => undefined);
}

/* ---------------- la vue du joueur ---------------- */

export async function objectivesView(allianceId: string, now = new Date()) {
  const weekStart = startOfParisWeek(now);
  const week = (await prisma.allianceWeek.findUnique({ where: { allianceId_weekStart: { allianceId, weekStart } } })) as WeekRow | null;
  if (!week) return null;
  const objectives = week.objectives as AllianceObjective[];
  return {
    weekStart,
    endsAt: new Date(weekStart.getTime() + 7 * DAY_MS),
    bonus: { coins: ALL_DONE_COINS, points: ALL_DONE_POINTS, paid: week.bonusPaid },
    objectives: objectives.map((o) => ({
      kind: o.kind,
      label: o.label,
      target: o.target,
      coins: o.coins,
      points: o.points,
      progress: Math.min(o.target, Number(week.progress?.[o.kind] ?? 0)),
      done: Boolean(week.done?.[o.kind]),
      shares: Object.entries((week.shares?.[o.kind] ?? {}) as Record<string, number>).map(([companyId, value]) => ({ companyId, value })),
    })),
  };
}
