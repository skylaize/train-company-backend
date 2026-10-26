import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

/* ============================================================
   2.4 : les compteurs « depuis toujours » de chaque compagnie.

   Le classement (toutes les 45 s), les cours de bourse, les paliers de
   parrainage et la réputation additionnaient la table Transaction ENTIÈRE
   (des millions de lignes, qui grossissent à chaque trajet) et rapatriaient
   tous les incidents dans Node, à chaque calcul. C'était l'essentiel du
   processeur de la base, d'où les pics à 100 %.

   Ici, la somme complète n'est faite qu'au démarrage (et une fois par jour,
   pour corriger une éventuelle dérive : compagnie supprimée…). Ensuite, on
   n'ajoute que les lignes arrivées depuis le dernier passage : quelques
   centaines, lues grâce à l'index sur createdAt.

   Les bornes sont lues dans la base elle-même (MAX(createdAt) moins une
   minute, en texte) et renvoyées telles quelles : on ne mélange jamais
   l'horloge du serveur Node et celle de la colonne. La minute de marge
   laisse aux transactions en cours le temps d'être validées.
   ============================================================ */

export type Lifetime = { revenue: number; trips: number; incidents: number };

const DELTA_EVERY_MS = 60_000;
const FULL_EVERY_MS = 24 * 3_600_000;

let stats: Map<string, Lifetime> | null = null;
let txMark: string | null = null; // createdAt (texte) jusqu'où les transactions sont comptées
let incMark: string | null = null; // idem pour les incidents
let lastDelta = 0;
let lastFull = 0;
let inflight: Promise<Map<string, Lifetime>> | null = null;

const FMT = `'YYYY-MM-DD"T"HH24:MI:SS.MS'`;

async function upperMarks(): Promise<{ tx: string | null; inc: string | null }> {
  const [tx, inc] = await Promise.all([
    prisma.$queryRawUnsafe<{ m: string | null }[]>(`SELECT to_char(MAX("createdAt") - interval '60 seconds', ${FMT}) AS m FROM "Transaction"`),
    prisma.$queryRawUnsafe<{ m: string | null }[]>(`SELECT to_char(MAX("createdAt") - interval '60 seconds', ${FMT}) AS m FROM "Incident"`),
  ]);
  return { tx: tx[0]?.m ?? null, inc: inc[0]?.m ?? null };
}

/* Sommes par compagnie sur la tranche ]from, to]. from nul = depuis le début. */
async function slice(fromTx: string | null, toTx: string | null, fromInc: string | null, toInc: string | null) {
  const [tx, inc] = await Promise.all([
    toTx
      ? prisma.$queryRaw<{ companyId: string; revenue: bigint | number | null; trips: number }[]>`
          SELECT "companyId",
                 COALESCE(SUM("amount") FILTER (WHERE "amount" > 0 AND "type" <> 'FONDATION'), 0)::bigint AS revenue,
                 (COUNT(*) FILTER (WHERE "type" = 'REVENU_LIGNE'))::int AS trips
          FROM "Transaction"
          WHERE "createdAt" <= ${toTx}::timestamp(3) ${fromTx ? Prisma.sql`AND "createdAt" > ${fromTx}::timestamp(3)` : Prisma.empty}
          GROUP BY "companyId"`
      : Promise.resolve([]),
    toInc
      ? prisma.$queryRaw<{ companyId: string; n: number }[]>`
          SELECT t."companyId", COUNT(*)::int AS n
          FROM "Incident" i JOIN "Train" t ON t."id" = i."trainId"
          WHERE i."createdAt" <= ${toInc}::timestamp(3) ${fromInc ? Prisma.sql`AND i."createdAt" > ${fromInc}::timestamp(3)` : Prisma.empty}
          GROUP BY t."companyId"`
      : Promise.resolve([]),
  ]);
  return { tx, inc };
}

function addInto(map: Map<string, Lifetime>, part: Awaited<ReturnType<typeof slice>>) {
  for (const r of part.tx) {
    const s = map.get(r.companyId) ?? { revenue: 0, trips: 0, incidents: 0 };
    s.revenue += Number(r.revenue ?? 0);
    s.trips += Number(r.trips ?? 0);
    map.set(r.companyId, s);
  }
  for (const r of part.inc) {
    const s = map.get(r.companyId) ?? { revenue: 0, trips: 0, incidents: 0 };
    s.incidents += Number(r.n ?? 0);
    map.set(r.companyId, s);
  }
}

async function refresh(): Promise<Map<string, Lifetime>> {
  const marks = await upperMarks();
  const full = !stats || Date.now() - lastFull > FULL_EVERY_MS;
  if (full) {
    const next = new Map<string, Lifetime>();
    addInto(next, await slice(null, marks.tx, null, marks.inc));
    stats = next;
    lastFull = Date.now();
  } else {
    const toTx = marks.tx && (!txMark || marks.tx > txMark) ? marks.tx : null;
    const toInc = marks.inc && (!incMark || marks.inc > incMark) ? marks.inc : null;
    if (toTx || toInc) addInto(stats!, await slice(txMark, toTx, incMark, toInc));
  }
  if (marks.tx && (!txMark || marks.tx > txMark)) txMark = marks.tx;
  if (marks.inc && (!incMark || marks.inc > incMark)) incMark = marks.inc;
  lastDelta = Date.now();
  return stats!;
}

function run() {
  if (!inflight) {
    inflight = refresh().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/* Compteurs de toutes les compagnies. Le premier appel attend la somme
   complète ; ensuite la valeur connue est rendue tout de suite, et complétée
   en arrière-plan au plus une fois par minute (retard d'une à deux minutes,
   invisible pour un classement ou une réputation). */
export async function lifetimeStats(): Promise<Map<string, Lifetime>> {
  if (!stats) return run();
  if (Date.now() - lastDelta > DELTA_EVERY_MS) void run().catch((err) => console.error("[compteurs] mise à jour :", (err as Error).message));
  return stats;
}
