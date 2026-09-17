import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

export async function listMyAchievements(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    include: { _count: { select: { trains: true, lines: true } } },
  });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const [
    deliveredCount,
    repairCount,
    incidentCount,
    enRouteCount,
    allCompanies,
    staffCount,
    riskyTakenCount,
    claimedChallengesCount,
    transactionCount,
    linesForStations,
  ] = await Promise.all([
    prisma.contract.count({ where: { companyId: company.id, status: "LIVREE" } }),
    prisma.transaction.count({ where: { companyId: company.id, type: "REPARATION" } }),
    prisma.incident.count({ where: { train: { companyId: company.id } } }),
    prisma.train.count({ where: { companyId: company.id, status: "EN_ROUTE", lineId: { not: null } } }),
    prisma.company.findMany({ orderBy: { balance: "desc" }, select: { id: true } }),
    prisma.staff.count({ where: { companyId: company.id } }),
    prisma.contract.count({ where: { companyId: company.id, risky: true } }),
    prisma.dailyChallenge.count({ where: { companyId: company.id, claimed: true } }),
    prisma.transaction.count({ where: { companyId: company.id } }),
    prisma.line.findMany({ where: { companyId: company.id }, select: { departureStation: true, arrivalStation: true } }),
  ]);

  const rank = allCompanies.findIndex((c) => c.id === company.id) + 1;
  const distinctStations = new Set(linesForStations.flatMap((l) => [l.departureStation, l.arrivalStation])).size;

  const achievements = [
    {
      id: "premier-trace",
      name: "Premier tracé",
      description: "Créer votre première ligne",
      unlocked: company._count.lines >= 1,
    },
    {
      id: "sur-les-rails",
      name: "Sur les rails",
      description: "Mettre un train en circulation sur une ligne",
      unlocked: enRouteCount >= 1,
    },
    {
      id: "entrepreneur-fret",
      name: "Entrepreneur du fret",
      description: "Livrer un premier contrat de marchandises",
      unlocked: deliveredCount >= 1,
    },
    {
      id: "petit-empire",
      name: "Petit empire",
      description: "Posséder 3 rames ou plus",
      unlocked: company._count.trains >= 3,
    },
    {
      id: "coffres-pleins",
      name: "Coffres pleins",
      description: "Atteindre 2000 pièces de trésorerie",
      unlocked: company.balance >= 2000,
    },
    {
      id: "increvable",
      name: "Increvable",
      description: "Réparer une rame après une panne",
      unlocked: repairCount >= 1,
    },
    {
      id: "resilient",
      name: "Résilient",
      description: "Traverser un premier incident réseau",
      unlocked: incidentCount >= 1,
    },
    {
      id: "podium",
      name: "Sur le podium",
      description: "Figurer dans le top 3 du classement national",
      unlocked: rank > 0 && rank <= 3,
    },
    {
      id: "champion",
      name: "Champion du réseau",
      description: "Atteindre la 1ère place du classement national",
      unlocked: rank === 1,
    },
    {
      id: "recrue-du-rail",
      name: "Recrue du rail",
      description: "Embaucher votre premier employé",
      unlocked: staffCount >= 1,
    },
    {
      id: "duo-gagnant",
      name: "Duo gagnant",
      description: "Avoir les deux postes de personnel pourvus en même temps",
      unlocked: staffCount >= 2,
    },
    {
      id: "preneur-de-risques",
      name: "Preneur de risques",
      description: "Accepter un premier contrat de fret à marchandise fragile",
      unlocked: riskyTakenCount >= 1,
    },
    {
      id: "defi-releve",
      name: "Défi relevé",
      description: "Récupérer la récompense d'un défi quotidien",
      unlocked: claimedChallengesCount >= 1,
    },
    {
      id: "grand-livre",
      name: "Grand livre",
      description: "Atteindre 20 mouvements dans l'historique de trésorerie",
      unlocked: transactionCount >= 20,
    },
    {
      id: "explorateur-du-reseau",
      name: "Explorateur du réseau",
      description: "Desservir au moins 5 gares différentes",
      unlocked: distinctStations >= 5,
    },
    {
      id: "flotte-imperiale",
      name: "Flotte impériale",
      description: "Agrandir le dépôt jusqu'à sa capacité maximale (6 rames)",
      unlocked: company.maxTrains >= 6,
    },
  ];

  return res.json(achievements);
}
