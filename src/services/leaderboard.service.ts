import { prisma } from "../prisma";
import { rankFromContext, CareerContext } from "./career.service";

/* Prix d'achat des rames : sert à valoriser le parc, pas seulement les liquidités.
   Doit rester aligné sur TRAIN_MODELS dans train.controller.ts. */
const TRAIN_VALUE: Record<string, number> = {
  STANDARD: 200,
  EXPRESS: 450,
  FRET_LOURD: 450,
};

/* Une rame usée à 100 % ne vaut plus que la moitié de son prix. */
function trainWorth(model: string, wear: number) {
  const base = TRAIN_VALUE[model] ?? TRAIN_VALUE.STANDARD;
  return Math.round(base * (1 - Math.min(100, Math.max(0, wear)) / 200));
}

/* Somme réellement dépensée pour agrandir le dépôt : chaque place coûte
   maxTrains × 200, en partant de 2 places offertes à la fondation. */
function depotInvestment(maxTrains: number) {
  if (maxTrains <= 2) return 0;
  return 200 * (((maxTrains - 1) * maxTrains) / 2 - 1);
}

/* Nombre minimum de trajets avant d'apparaître au classement de ponctualité :
   sans ce seuil, une compagnie neuve avec un seul trajet trônerait à 100 %. */
export const PUNCTUALITY_MIN_SAMPLE = 10;

export type BoardId = "valeur" | "livraisons" | "ponctualite" | "parrains";

export interface LeaderRow {
  id: string;
  name: string;
  liveryColor: string;
  grade: string;
  gradeId: number;
  title: string | null;
  trains: number;
  lines: number;
  valeur: number;
  livraisons: number;
  ponctualite: number;
  ponctualiteSample: number;
  parrains: number;
}

/* Additionne des couples (compagnie, valeur) en ignorant les lignes sans compagnie. */
function sumByCompany(pairs: Array<[string | null, number]>) {
  const map = new Map<string, number>();
  for (const [key, value] of pairs) {
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + value);
  }
  return map;
}

/* Huit requêtes d'agrégation par appel, et chaque tableau de bord connecté
   redemande le classement toutes les dix secondes. Quinze secondes de cache :
   assez court pour que le classement reste vivant, assez long pour que la base
   ne refasse pas le même calcul pour chaque joueur. */
const ROWS_TTL_MS = 15_000;
let rowsCache: { at: number; rows: LeaderRow[] } | null = null;

export async function buildLeaderRows(): Promise<LeaderRow[]> {
  if (rowsCache && Date.now() - rowsCache.at < ROWS_TTL_MS) return rowsCache.rows;

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [companies, trains, revenue, delivered, freightWeek, goodTrips, incidents, referrals] =
    await Promise.all([
      prisma.company.findMany({
        select: {
          id: true,
          name: true,
          liveryColor: true,
          balance: true,
          maxTrains: true,
          title: true,
          _count: { select: { trains: true, lines: true, staff: true } },
        },
      }),
      prisma.train.findMany({ select: { companyId: true, model: true, wear: true } }),
      prisma.transaction.groupBy({
        by: ["companyId"],
        where: { amount: { gt: 0 }, type: { not: "FONDATION" } },
        _sum: { amount: true },
      }),
      prisma.contract.groupBy({
        by: ["companyId"],
        where: { status: "LIVREE" },
        _count: { _all: true },
      }),
      prisma.transaction.groupBy({
        by: ["companyId"],
        where: { type: "FRET", amount: { gt: 0 }, createdAt: { gte: weekAgo } },
        _count: { _all: true },
      }),
      prisma.transaction.groupBy({
        by: ["companyId"],
        where: { type: "REVENU_LIGNE" },
        _count: { _all: true },
      }),
      // les incidents pointent sur un train : on remonte à la compagnie côté serveur
      prisma.incident.findMany({ select: { train: { select: { companyId: true } } } }),
      // un filleul ne compte que s'il a vraiment démarré (récompense déjà versée)
      prisma.company.groupBy({
        by: ["referredById"],
        where: { referredById: { not: null }, referralRewardGranted: true },
        _count: { _all: true },
      }),
    ]);

  const trainWorthByCompany = sumByCompany(
    trains.map((t: { companyId: string; model: string; wear: number }): [string | null, number] => [
      t.companyId,
      trainWorth(t.model, t.wear),
    ])
  );
  const revenueBy = sumByCompany(
    revenue.map((r: { companyId: string | null; _sum: { amount: number | null } }): [string | null, number] => [
      r.companyId,
      r._sum.amount ?? 0,
    ])
  );
  const deliveredBy = sumByCompany(
    delivered.map((d: { companyId: string | null; _count: { _all: number } }): [string | null, number] => [
      d.companyId,
      d._count._all,
    ])
  );
  const freightWeekBy = sumByCompany(
    freightWeek.map((f: { companyId: string | null; _count: { _all: number } }): [string | null, number] => [
      f.companyId,
      f._count._all,
    ])
  );
  const goodTripsBy = sumByCompany(
    goodTrips.map((g: { companyId: string | null; _count: { _all: number } }): [string | null, number] => [
      g.companyId,
      g._count._all,
    ])
  );
  const incidentsBy = sumByCompany(
    incidents.map((i: { train: { companyId: string } | null }): [string | null, number] => [
      i.train?.companyId ?? null,
      1,
    ])
  );
  const referralsBy = sumByCompany(
    referrals.map((r: { referredById: string | null; _count: { _all: number } }): [string | null, number] => [
      r.referredById,
      r._count._all,
    ])
  );

  type CompanyRow = {
    id: string;
    name: string;
    liveryColor: string;
    balance: number;
    maxTrains: number;
    title: string | null;
    _count: { trains: number; lines: number; staff: number };
  };

  const rows: LeaderRow[] = companies.map((c: CompanyRow) => {
    const good = goodTripsBy.get(c.id) ?? 0;
    const bad = incidentsBy.get(c.id) ?? 0;
    const sample = good + bad;
    const ponctualite = sample === 0 ? 100 : Math.round((good / sample) * 100);

    const ctx: CareerContext = {
      trainCount: c._count.trains,
      lineCount: c._count.lines,
      staffCount: c._count.staff,
      freightDelivered: deliveredBy.get(c.id) ?? 0,
      totalRevenue: revenueBy.get(c.id) ?? 0,
      reputation: ponctualite,
      maxTrains: c.maxTrains,
    };

    return {
      id: c.id,
      name: c.name,
      liveryColor: c.liveryColor,
      grade: rankFromContext(ctx).name,
      gradeId: rankFromContext(ctx).id,
      title: c.title,
      trains: c._count.trains,
      lines: c._count.lines,
      // la valeur remplace la trésorerie brute : acheter une rame ne fait plus reculer
      valeur: c.balance + (trainWorthByCompany.get(c.id) ?? 0) + depotInvestment(c.maxTrains),
      livraisons: freightWeekBy.get(c.id) ?? 0,
      ponctualite,
      ponctualiteSample: sample,
      parrains: referralsBy.get(c.id) ?? 0,
    };
  });

  rowsCache = { at: Date.now(), rows };
  return rows;
}

export const BOARDS: { id: BoardId; label: string; note: string; unit: string; missing: string }[] = [
  {
    id: "valeur",
    label: "Valeur",
    note: "Trésorerie, matériel et dépôt réunis",
    unit: "pi.",
    missing: "Fondez votre compagnie pour entrer au classement.",
  },
  {
    id: "livraisons",
    label: "Fret de la semaine",
    note: "Contrats livrés ces sept derniers jours",
    unit: "",
    missing: "Livrez un contrat de fret cette semaine pour y figurer.",
  },
  {
    id: "ponctualite",
    label: "Ponctualité",
    note: `À partir de ${PUNCTUALITY_MIN_SAMPLE} trajets effectués`,
    unit: "%",
    missing: `Effectuez ${PUNCTUALITY_MIN_SAMPLE} trajets pour y figurer — en dessous, le pourcentage ne veut rien dire.`,
  },
  {
    id: "parrains",
    label: "Parrains",
    note: "Filleuls ayant réellement pris le départ",
    unit: "",
    missing: "Invitez un ami : il apparaît ici dès qu'il a lancé sa première ligne.",
  },
];

export function rankRows(rows: LeaderRow[], board: BoardId) {
  const eligible =
    board === "ponctualite"
      ? rows.filter((r) => r.ponctualiteSample >= PUNCTUALITY_MIN_SAMPLE)
      : board === "parrains"
      ? rows.filter((r) => r.parrains > 0)
      : board === "livraisons"
      ? rows.filter((r) => r.livraisons > 0)
      : rows;

  return [...eligible]
    .sort((a, b) => {
      const diff = b[board] - a[board];
      // à égalité, la compagnie la plus solide passe devant
      return diff !== 0 ? diff : b.valeur - a.valeur;
    })
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
