import { prisma } from "../prisma";
import { computeReputation } from "./reputation.service";

export interface CareerRequirement {
  label: string;
  met: boolean;
  // progression chiffrée, pour la barre : « 12 / 20 gares »
  current: number;
  target: number;
}

export interface CareerRank {
  id: number;
  name: string;
  requirements: CareerRequirement[];
  achieved: boolean;
  reward: string | null;
}

export interface CareerContext {
  trainCount: number;
  lineCount: number;
  staffCount: number;
  freightDelivered: number;
  totalRevenue: number;
  reputation: number;
  maxTrains: number;
  distinctStations: number;
}

type Req = { label: string; value: (ctx: CareerContext) => number; target: number };
const req = (label: string, value: (ctx: CareerContext) => number, target: number): Req => ({ label, value, target });

// Chaque grade nécessite de remplir TOUTES ses conditions. Les seuils sont volontairement
// croissants d'un grade à l'autre, pour qu'atteindre un grade implique déjà les précédents.
/* 1.4 : cinq grades de plus au-delà du Magnat. Ils sont pensés pour les
   compagnies qui ont déjà tout : des dizaines de milliers de pièces ne suffisent
   pas, il faut un réseau étendu, du fret, une équipe et une réputation. Chaque
   nouveau grade donne son nom en titre à afficher au classement. */
export const RANK_DEFINITIONS: { name: string; reward: string | null; requirements: Req[] }[] = [
  { name: "Apprenti exploitant", reward: null, requirements: [] },
  {
    name: "Gestionnaire confirmé",
    reward: "Débloque la rame Express",
    requirements: [
      req("Posséder au moins 3 rames", (c) => c.trainCount, 3),
      req("Avoir tracé au moins 2 lignes", (c) => c.lineCount, 2),
      req("Avoir généré 1 000 pi. de recettes cumulées", (c) => c.totalRevenue, 1000),
    ],
  },
  {
    name: "Chef de réseau",
    reward: "Débloque la rame Fret Lourd et le directeur commercial",
    requirements: [
      req("Employer au moins 1 membre du personnel", (c) => c.staffCount, 1),
      req("Avoir livré 5 contrats de fret", (c) => c.freightDelivered, 5),
      req("Avoir généré 3 000 pi. de recettes cumulées", (c) => c.totalRevenue, 3000),
    ],
  },
  {
    name: "Baron du rail",
    reward: null,
    requirements: [
      req("Posséder au moins 5 rames", (c) => c.trainCount, 5),
      req("Réputation d'au moins 80 %", (c) => c.reputation, 80),
      req("Avoir généré 8 000 pi. de recettes cumulées", (c) => c.totalRevenue, 8000),
    ],
  },
  {
    name: "Magnat ferroviaire",
    reward: null,
    requirements: [
      req("Employer au moins 2 membres du personnel", (c) => c.staffCount, 2),
      req("Dépôt porté à 6 places ou plus", (c) => c.maxTrains, 6),
      req("Avoir généré 20 000 pi. de recettes cumulées", (c) => c.totalRevenue, 20000),
    ],
  },
  {
    name: "Directeur régional",
    reward: "Titre « Directeur régional » au classement",
    requirements: [
      req("Posséder au moins 8 rames", (c) => c.trainCount, 8),
      req("Desservir 12 gares différentes", (c) => c.distinctStations, 12),
      req("Avoir livré 25 contrats de fret", (c) => c.freightDelivered, 25),
      req("Avoir généré 50 000 pi. de recettes cumulées", (c) => c.totalRevenue, 50000),
    ],
  },
  {
    name: "Directeur national",
    reward: "Titre « Directeur national » au classement",
    requirements: [
      req("Posséder au moins 10 rames", (c) => c.trainCount, 10),
      req("Desservir 20 gares différentes", (c) => c.distinctStations, 20),
      req("Employer au moins 3 membres du personnel", (c) => c.staffCount, 3),
      req("Avoir généré 120 000 pi. de recettes cumulées", (c) => c.totalRevenue, 120000),
    ],
  },
  {
    name: "Administrateur des chemins de fer",
    reward: "Titre « Administrateur des chemins de fer » au classement",
    requirements: [
      req("Dépôt porté à 12 places ou plus", (c) => c.maxTrains, 12),
      req("Réputation d'au moins 85 %", (c) => c.reputation, 85),
      req("Avoir livré 80 contrats de fret", (c) => c.freightDelivered, 80),
      req("Avoir généré 250 000 pi. de recettes cumulées", (c) => c.totalRevenue, 250000),
    ],
  },
  {
    name: "Président de compagnie",
    reward: "Titre « Président de compagnie » au classement",
    requirements: [
      req("Posséder au moins 14 rames", (c) => c.trainCount, 14),
      req("Desservir 30 gares différentes", (c) => c.distinctStations, 30),
      req("Employer au moins 5 membres du personnel", (c) => c.staffCount, 5),
      req("Avoir généré 500 000 pi. de recettes cumulées", (c) => c.totalRevenue, 500000),
    ],
  },
  {
    name: "Légende du rail",
    reward: "Titre « Légende du rail » au classement",
    requirements: [
      req("Desservir les 38 gares du réseau", (c) => c.distinctStations, 38),
      req("Réputation d'au moins 90 %", (c) => c.reputation, 90),
      req("Avoir livré 250 contrats de fret", (c) => c.freightDelivered, 250),
      req("Avoir généré 1 000 000 pi. de recettes cumulées", (c) => c.totalRevenue, 1000000),
    ],
  },
];

// titres gagnés en carrière : le nom de chaque grade à partir du Directeur régional
export const CAREER_TITLE_FROM = 5;
export function careerTitles(gradeId: number) {
  return RANK_DEFINITIONS.slice(CAREER_TITLE_FROM, gradeId + 1).map((r) => r.name);
}

const met = (r: Req, ctx: CareerContext) => r.value(ctx) >= r.target;

/* Grade atteint pour un contexte donné, sans aucune requête : le classement
   s'en sert pour étiqueter toutes les compagnies d'un coup. */
export function rankFromContext(ctx: CareerContext) {
  let current = 0;
  RANK_DEFINITIONS.forEach((def, id) => {
    if (def.requirements.every((r) => met(r, ctx))) current = id;
  });
  return { id: current, name: RANK_DEFINITIONS[current].name };
}

export async function computeCareerStatus(companyId: string) {
  const [trainCount, lines, staffCount, freightDelivered, revenueAgg, reputation, company] = await Promise.all([
    prisma.train.count({ where: { companyId } }),
    prisma.line.findMany({ where: { companyId }, select: { departureStation: true, arrivalStation: true } }),
    prisma.staff.count({ where: { companyId } }),
    prisma.contract.count({ where: { companyId, status: "LIVREE" } }),
    prisma.transaction.aggregate({
      where: { companyId, amount: { gt: 0 }, type: { not: "FONDATION" } },
      _sum: { amount: true },
    }),
    computeReputation(companyId),
    prisma.company.findUnique({ where: { id: companyId }, select: { maxTrains: true } }),
  ]);

  const lineList = lines as { departureStation: string; arrivalStation: string }[];
  const ctx: CareerContext = {
    trainCount,
    lineCount: lineList.length,
    staffCount,
    freightDelivered,
    totalRevenue: revenueAgg._sum.amount ?? 0,
    reputation,
    maxTrains: company?.maxTrains ?? 2,
    distinctStations: new Set(lineList.flatMap((l) => [l.departureStation, l.arrivalStation])).size,
  };

  const ranks: CareerRank[] = RANK_DEFINITIONS.map((def, id) => ({
    id,
    name: def.name,
    reward: def.reward,
    requirements: def.requirements.map((r) => ({
      label: r.label,
      met: met(r, ctx),
      current: Math.min(r.target, Math.floor(r.value(ctx))),
      target: r.target,
    })),
    achieved: def.requirements.every((r) => met(r, ctx)),
  }));

  // une seule source de vérité : la même fonction que celle utilisée par le classement
  const currentRankId = rankFromContext(ctx).id;

  return {
    currentRank: ranks[currentRankId],
    nextRank: ranks[currentRankId + 1] ?? null,
    ranks,
  };
}
