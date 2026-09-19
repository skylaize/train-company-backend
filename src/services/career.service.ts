import { prisma } from "../prisma";
import { computeReputation } from "./reputation.service";

export interface CareerRequirement {
  label: string;
  met: boolean;
}

export interface CareerRank {
  id: number;
  name: string;
  requirements: CareerRequirement[];
  achieved: boolean;
}

interface CareerContext {
  trainCount: number;
  lineCount: number;
  staffCount: number;
  freightDelivered: number;
  totalRevenue: number;
  reputation: number;
  maxTrains: number;
}

// Chaque grade nécessite de remplir TOUTES ses conditions. Les seuils sont volontairement
// croissants d'un grade à l'autre, pour qu'atteindre un grade implique déjà les précédents.
const RANK_DEFINITIONS: {
  name: string;
  requirements: { label: string; check: (ctx: CareerContext) => boolean }[];
}[] = [
  {
    name: "Apprenti exploitant",
    requirements: [],
  },
  {
    name: "Gestionnaire confirmé",
    requirements: [
      { label: "Posséder au moins 3 rames", check: (ctx) => ctx.trainCount >= 3 },
      { label: "Avoir tracé au moins 2 lignes", check: (ctx) => ctx.lineCount >= 2 },
      { label: "Avoir généré 1 000 pi. de recettes cumulées", check: (ctx) => ctx.totalRevenue >= 1000 },
    ],
  },
  {
    name: "Chef de réseau",
    requirements: [
      { label: "Employer au moins 1 membre du personnel", check: (ctx) => ctx.staffCount >= 1 },
      { label: "Avoir livré 5 contrats de fret", check: (ctx) => ctx.freightDelivered >= 5 },
      { label: "Avoir généré 3 000 pi. de recettes cumulées", check: (ctx) => ctx.totalRevenue >= 3000 },
    ],
  },
  {
    name: "Baron du rail",
    requirements: [
      { label: "Posséder au moins 5 rames", check: (ctx) => ctx.trainCount >= 5 },
      { label: "Réputation d'au moins 80%", check: (ctx) => ctx.reputation >= 80 },
      { label: "Avoir généré 8 000 pi. de recettes cumulées", check: (ctx) => ctx.totalRevenue >= 8000 },
    ],
  },
  {
    name: "Magnat ferroviaire",
    requirements: [
      { label: "Employer au moins 2 membres du personnel", check: (ctx) => ctx.staffCount >= 2 },
      { label: "Dépôt agrandi à sa capacité maximale (6 rames)", check: (ctx) => ctx.maxTrains >= 6 },
      { label: "Avoir généré 20 000 pi. de recettes cumulées", check: (ctx) => ctx.totalRevenue >= 20000 },
    ],
  },
];

export async function computeCareerStatus(companyId: string) {
  const [trainCount, lines, staffCount, freightDelivered, revenueAgg, reputation, company] = await Promise.all([
    prisma.train.count({ where: { companyId } }),
    prisma.line.count({ where: { companyId } }),
    prisma.staff.count({ where: { companyId } }),
    prisma.contract.count({ where: { companyId, status: "LIVREE" } }),
    prisma.transaction.aggregate({
      where: { companyId, amount: { gt: 0 }, type: { not: "FONDATION" } },
      _sum: { amount: true },
    }),
    computeReputation(companyId),
    prisma.company.findUnique({ where: { id: companyId }, select: { maxTrains: true } }),
  ]);

  const ctx: CareerContext = {
    trainCount,
    lineCount: lines,
    staffCount,
    freightDelivered,
    totalRevenue: revenueAgg._sum.amount ?? 0,
    reputation,
    maxTrains: company?.maxTrains ?? 2,
  };

  const ranks: CareerRank[] = RANK_DEFINITIONS.map((def, id) => ({
    id,
    name: def.name,
    requirements: def.requirements.map((r) => ({ label: r.label, met: r.check(ctx) })),
    achieved: def.requirements.every((r) => r.check(ctx)),
  }));

  // le grade actuel est le plus élevé dont toutes les conditions sont remplies
  let currentRankId = 0;
  for (const rank of ranks) {
    if (rank.achieved) currentRankId = rank.id;
  }

  return {
    currentRank: ranks[currentRankId],
    nextRank: ranks[currentRankId + 1] ?? null,
    ranks,
  };
}
