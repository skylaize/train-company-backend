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
    existingUnlocks,
    distinctModels,
    insuredCount,
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
    prisma.achievementUnlock.findMany({ where: { companyId: company.id }, select: { achievementId: true } }),
    prisma.train.findMany({ where: { companyId: company.id }, select: { model: true }, distinct: ["model"] }),
    prisma.contract.count({ where: { companyId: company.id, insured: true } }),
  ]);

  const rank = allCompanies.findIndex((c) => c.id === company.id) + 1;
  const distinctStations = new Set(linesForStations.flatMap((l) => [l.departureStation, l.arrivalStation])).size;
  const alreadyUnlocked = new Set(existingUnlocks.map((u) => u.achievementId));
  const daysSinceCreation = (Date.now() - new Date(company.createdAt).getTime()) / (1000 * 60 * 60 * 24);

  // Condition remplie "en ce moment" pour chaque succès. Un succès déjà persisté reste acquis
  // pour toujours, même si la condition ne l'est plus (ex. trésorerie redescendue sous le seuil).
  const definitions = [
    {
      id: "premier-trace",
      name: "Premier tracé",
      description: "Créer votre première ligne",
      liveMet: company._count.lines >= 1,
    },
    {
      id: "sur-les-rails",
      name: "Sur les rails",
      description: "Mettre un train en circulation sur une ligne",
      liveMet: enRouteCount >= 1,
    },
    {
      id: "entrepreneur-fret",
      name: "Entrepreneur du fret",
      description: "Livrer un premier contrat de marchandises",
      liveMet: deliveredCount >= 1,
    },
    {
      id: "petit-empire",
      name: "Petit empire",
      description: "Posséder 3 rames ou plus",
      liveMet: company._count.trains >= 3,
    },
    {
      id: "coffres-pleins",
      name: "Coffres pleins",
      description: "Atteindre 2000 pièces de trésorerie",
      liveMet: company.balance >= 2000,
    },
    {
      id: "increvable",
      name: "Increvable",
      description: "Réparer une rame après une panne",
      liveMet: repairCount >= 1,
    },
    {
      id: "resilient",
      name: "Résilient",
      description: "Traverser un premier incident réseau",
      liveMet: incidentCount >= 1,
    },
    {
      id: "podium",
      name: "Sur le podium",
      description: "Figurer dans le top 3 du classement national",
      liveMet: rank > 0 && rank <= 3,
    },
    {
      id: "champion",
      name: "Champion du réseau",
      description: "Atteindre la 1ère place du classement national",
      liveMet: rank === 1,
    },
    {
      id: "recrue-du-rail",
      name: "Recrue du rail",
      description: "Embaucher votre premier employé",
      liveMet: staffCount >= 1,
    },
    {
      id: "duo-gagnant",
      name: "Duo gagnant",
      description: "Avoir au moins deux postes de personnel pourvus en même temps",
      liveMet: staffCount >= 2,
    },
    {
      id: "preneur-de-risques",
      name: "Preneur de risques",
      description: "Accepter un premier contrat de fret à marchandise fragile",
      liveMet: riskyTakenCount >= 1,
    },
    {
      id: "defi-releve",
      name: "Défi relevé",
      description: "Récupérer la récompense d'un défi quotidien",
      liveMet: claimedChallengesCount >= 1,
    },
    {
      id: "grand-livre",
      name: "Grand livre",
      description: "Atteindre 20 mouvements dans l'historique de trésorerie",
      liveMet: transactionCount >= 20,
    },
    {
      id: "explorateur-du-reseau",
      name: "Explorateur du réseau",
      description: "Desservir au moins 5 gares différentes",
      liveMet: distinctStations >= 5,
    },
    {
      id: "flotte-imperiale",
      name: "Flotte impériale",
      description: "Agrandir le dépôt jusqu'à sa capacité maximale (6 rames)",
      liveMet: company.maxTrains >= 6,
    },
    {
      id: "veteran-du-rail",
      name: "Vétéran du rail",
      description: "Exploiter votre compagnie depuis 30 jours",
      liveMet: daysSinceCreation >= 30,
    },
    {
      id: "passage-au-premium",
      name: "Passage au Premium",
      description: "Devenir une compagnie Premium",
      liveMet: company.isPremium,
    },
    {
      id: "flotte-diversifiee",
      name: "Flotte diversifiée",
      description: "Posséder à la fois une rame Standard, Express et Fret Lourd",
      liveMet: distinctModels.length >= 3,
    },
    {
      id: "equipe-complete",
      name: "Équipe complète",
      description: "Avoir les trois postes de personnel pourvus en même temps",
      liveMet: staffCount >= 3,
    },
    {
      id: "assure-comme-il-faut",
      name: "Assuré comme il faut",
      description: "Accepter un premier contrat de fret assuré",
      liveMet: insuredCount >= 1,
    },
    {
      id: "grand-reseau",
      name: "Grand réseau",
      description: "Avoir tracé au moins 6 lignes",
      liveMet: company._count.lines >= 6,
    },
  ];

  // les succès nouvellement atteints (mais pas encore persistés) sont enregistrés définitivement
  const newlyUnlocked = definitions.filter((d) => d.liveMet && !alreadyUnlocked.has(d.id));
  if (newlyUnlocked.length > 0) {
    await prisma.achievementUnlock.createMany({
      data: newlyUnlocked.map((d) => ({ companyId: company.id, achievementId: d.id })),
      skipDuplicates: true,
    });
  }

  const achievements = definitions.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    unlocked: d.liveMet || alreadyUnlocked.has(d.id),
  }));

  return res.json(achievements);
}
