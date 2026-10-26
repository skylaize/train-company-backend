import { prisma } from "../prisma";
import { Prisma } from "@prisma/client";
import { chunk, row } from "./batch.service";
import { economy } from "./settings.service";
import { distanceKm } from "./geography.service";

/* ============================================================
   2.4 : la voie s'use, et elle peut avoir un propriétaire.

   - Chaque liaison entre deux gares voisines d'un itinéraire a un état, de
     0 à 100 %. Chaque train qui passe l'use un peu : les liaisons très
     fréquentées s'usent vite. Sous 60 %, les trains y roulent 10 % moins
     vite ; sous 30 %, 25 % moins vite et deux fois plus d'incidents.
   - La rénovation est un chantier commun : chacun verse ce qu'il veut dans
     la cagnotte de la liaison ; quand elle couvre le chantier, la voie
     repasse à 100 %. Ceux qui ont payé au moins 20 % du chantier touchent
     +3 % sur les trajets qui l'empruntent pendant un mois.
   - Une liaison peut avoir un concessionnaire : il fixe un péage (0 à 15 %
     de la recette des autres compagnies, au prorata de la longueur), mais
     doit l'entretenir. Sous 50 % pendant trois jours, il la perd.
   ============================================================ */

export function segmentKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function segmentsOf(route: string[]) {
  const keys: string[] = [];
  for (let i = 0; i < route.length - 1; i++) if (route[i] !== route[i + 1]) keys.push(segmentKey(route[i], route[i + 1]));
  return keys;
}

export function segmentKm(key: string) {
  const [a, b] = key.split("|");
  return distanceKm(a, b) ?? 0;
}

/* L'état des voies, relu une fois par tour. */
type SegState = { condition: number; concession: { companyId: string; toll: number } | null };
let segs = new Map<string, SegState>();
let cofunders = new Map<string, Set<string>>(); // liaison → compagnies co-financeuses (bonus en cours)
let pendingWear = new Map<string, number>();
let pendingTolls = new Map<string, number>(); // liaison → péages dus au concessionnaire

export async function loadTrack(now = new Date()) {
  const s = economy();
  const rows = (await prisma.trackSegment.findMany({
    select: { key: true, condition: true, concession: { select: { companyId: true, toll: true } } },
  }).catch(() => [])) as { key: string; condition: number; concession: { companyId: string; toll: number } | null }[];
  segs = new Map(rows.map((r) => [r.key, { condition: r.condition, concession: r.concession }]));
  // les co-financeurs des rénovations du dernier mois
  const since = new Date(now.getTime() - s.cofunderDays * 86_400_000);
  const renovated = (await prisma.trackSegment.findMany({
    where: { renovatedAt: { gte: since } },
    select: { key: true, round: true },
  }).catch(() => [])) as { key: string; round: number }[];
  const next = new Map<string, Set<string>>();
  for (const seg of renovated) {
    // la dernière rénovation terminée porte le numéro round − 1
    const fundings = (await prisma.trackFunding.findMany({
      where: { segmentKey: seg.key, round: seg.round - 1 },
      select: { companyId: true, amount: true },
    })) as { companyId: string; amount: number }[];
    const total = fundings.reduce((a, f) => a + f.amount, 0);
    const byCo = new Map<string, number>();
    for (const f of fundings) byCo.set(f.companyId, (byCo.get(f.companyId) ?? 0) + f.amount);
    const set = new Set<string>();
    for (const [co, amt] of byCo) if (total > 0 && amt / total >= s.cofunderShare) set.add(co);
    if (set.size) next.set(seg.key, set);
  }
  cofunders = next;
}

export function segmentCondition(key: string) {
  return segs.get(key)?.condition ?? 100;
}

/* Ce que l'état de la voie fait à un trajet : la pire liaison de l'itinéraire. */
export function routeTrack(route: string[]) {
  const s = economy();
  let worst = 100;
  for (const k of segmentsOf(route)) worst = Math.min(worst, segmentCondition(k));
  const slow = worst < s.trackBadFrom ? s.trackBadFactor : worst < s.trackSlowFrom ? s.trackSlowFactor : 1;
  const incident = worst < s.trackBadFrom ? s.trackBadIncidents : 1;
  return { worst, slow, incident };
}

/* Bonus des co-financeurs sur les trajets qui empruntent la liaison rénovée. */
export function cofunderMultiplier(route: string[], companyId: string) {
  const s = economy();
  return segmentsOf(route).some((k) => cofunders.get(k)?.has(companyId)) ? 1 + s.cofunderBonus : 1;
}

/* Un trajet use les liaisons qu'il emprunte (écrit à la fin du tour). */
export function wearTrack(route: string[], factor = 1) {
  const w = economy().trackWearPerTrip * factor;
  for (const k of segmentsOf(route)) pendingWear.set(k, (pendingWear.get(k) ?? 0) + w);
}

/* Péage dû par un trajet : sur chaque liaison concédée à une autre compagnie,
   la part de la recette au prorata des kilomètres. Les alliés paient moitié. */
export function tollsFor(route: string[], companyId: string, revenue: number, allies: Set<string>) {
  const keys = segmentsOf(route);
  const totalKm = keys.reduce((a, k) => a + segmentKm(k), 0) || 1;
  let total = 0;
  const owed: { key: string; amount: number }[] = [];
  for (const k of keys) {
    const c = segs.get(k)?.concession;
    if (!c || c.companyId === companyId) continue;
    const share = segmentKm(k) / totalKm;
    const rate = Math.min(economy().maxToll, Math.max(0, c.toll)) * (allies.has(c.companyId) ? 0.5 : 1);
    const amount = Math.round(revenue * share * rate);
    if (amount <= 0) continue;
    total += amount;
    owed.push({ key: k, amount });
    pendingTolls.set(k, (pendingTolls.get(k) ?? 0) + amount);
  }
  return { total, owed };
}

export async function flushTrack() {
  if (pendingWear.size) {
    const batch = [...pendingWear.entries()];
    pendingWear = new Map();
    /* 2.4 : deux requêtes par paquet au lieu d'une par liaison. Les
       liaisons nouvelles sont créées (à 100 − usure), les autres décomptées. */
    for (const part of chunk(batch, 500)) {
      try {
        const created = await prisma.$queryRaw<{ key: string }[]>`
          INSERT INTO "TrackSegment" ("key", "condition", "updatedAt")
          SELECT v.key::text, GREATEST(0, 100 - v.w::float8), (NOW() AT TIME ZONE 'UTC')
          FROM (VALUES ${Prisma.join(part.map(([key, w]) => row([key, w])))}) AS v(key, w)
          ON CONFLICT ("key") DO NOTHING
          RETURNING "key"`;
        const fresh = new Set(created.map((c: { key: string }) => c.key));
        const rest = part.filter(([key]) => !fresh.has(key));
        if (rest.length) {
          await prisma.$executeRaw`
            UPDATE "TrackSegment" AS s SET "condition" = GREATEST(0, s."condition" - v.w::float8), "updatedAt" = (NOW() AT TIME ZONE 'UTC')
            FROM (VALUES ${Prisma.join(rest.map(([key, w]) => row([key, w])))}) AS v(key, w)
            WHERE s."key" = v.key::text`;
        }
      } catch (err) {
        console.error("[voies] usure :", (err as Error).message);
      }
    }
  }
  if (pendingTolls.size) {
    const batch = [...pendingTolls.entries()];
    pendingTolls = new Map();
    for (const part of chunk(batch, 500)) {
      await prisma.$executeRaw`
        UPDATE "Concession" AS c SET "pending" = c."pending" + v.amount::int
        FROM (VALUES ${Prisma.join(part.map(([key, amount]) => row([key, Math.round(amount)])))}) AS v(key, amount)
        WHERE c."segmentKey" = v.key::text`.catch((err: Error) => console.error("[voies] péages :", err.message));
    }
  }
}

/* Coût d'une rénovation complète, selon la longueur et l'état. */
export function renovationCost(key: string, condition = segmentCondition(key)) {
  const s = economy();
  return Math.max(50, Math.round((segmentKm(key) * s.renovationPerKm * (100 - condition)) / 100));
}

export function concessionPrice(key: string) {
  return Math.max(1000, Math.round(segmentKm(key) * economy().concessionPerKm / 10) * 10);
}

/* Chaque heure : les péages versés aux concessionnaires, et les concessions
   mal entretenues retirées. Renvoie les concessions perdues pour prévenir. */
export async function runConcessionsHourly(now = new Date()) {
  const s = economy();
  const all = (await prisma.concession.findMany({
    select: { id: true, segmentKey: true, companyId: true, pending: true, lowSince: true, segment: { select: { condition: true } } },
  })) as { id: string; segmentKey: string; companyId: string; pending: number; lowSince: Date | null; segment: { condition: number } }[];
  const lost: { companyId: string; segmentKey: string }[] = [];
  for (const c of all) {
    if (c.pending > 0) {
      await prisma.$transaction([
        prisma.concession.update({ where: { id: c.id }, data: { pending: 0, totalTolls: { increment: c.pending } } }),
        prisma.company.update({ where: { id: c.companyId }, data: { balance: { increment: c.pending } } }),
        prisma.transaction.create({ data: { companyId: c.companyId, type: "PEAGE_VOIE", amount: c.pending, description: `Péages de la liaison ${c.segmentKey.replace("|", " – ")}` } }),
      ]);
    }
    const low = c.segment.condition < s.concessionMinCondition;
    if (low && !c.lowSince) await prisma.concession.update({ where: { id: c.id }, data: { lowSince: now } });
    if (!low && c.lowSince) await prisma.concession.update({ where: { id: c.id }, data: { lowSince: null } });
    if (low && c.lowSince && now.getTime() - c.lowSince.getTime() > s.concessionGraceHours * 3_600_000) {
      await prisma.concession.delete({ where: { id: c.id } });
      lost.push({ companyId: c.companyId, segmentKey: c.segmentKey });
    }
  }
  return lost;
}

export function trackSnapshot() {
  return segs;
}
