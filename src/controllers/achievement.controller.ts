import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { mechanicCoverage } from "../services/staff.service";

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
    missionsDone,
    clientRelations,
    linesForDuration,
    missionPayouts,
    warehouse,
    cargoSales,
    constructionsDone,
    stockLots,
    staffRows,
    preventiveCount,
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
    // v1.2 : ordres honorés, relations clients, réseau et parrainage
    prisma.mission.count({ where: { companyId: company.id, status: "REUSSIE" } }),
    prisma.clientRelation.findMany({ where: { companyId: company.id }, select: { reputation: true } }),
    prisma.line.findMany({ where: { companyId: company.id }, select: { durationMinutes: true } }),
    prisma.transaction.aggregate({
      where: { companyId: company.id, type: "MISSION", amount: { gt: 0 } },
      _sum: { amount: true },
    }),
    // entrepôt, spéculation et chantiers
    prisma.warehouse.findUnique({ where: { companyId: company.id } }),
    prisma.transaction.findMany({
      where: { companyId: company.id, type: "VENTE_FRET" },
      select: { description: true },
    }),
    prisma.construction.count({ where: { companyId: company.id, done: true } }),
    prisma.stockLot.findMany({ where: { companyId: company.id }, select: { quantity: true } }),
    // v1.3 : personnel nommé et révisions préventives
    prisma.staff.findMany({ where: { companyId: company.id }, select: { role: true, level: true } }),
    prisma.transaction.count({
      where: { companyId: company.id, type: "REPARATION", description: { startsWith: "Révision préventive" } },
    }),
  ]);

  const rank = allCompanies.findIndex((c) => c.id === company.id) + 1;
  const distinctStations = new Set(linesForStations.flatMap((l) => [l.departureStation, l.arrivalStation])).size;
  const alreadyUnlocked = new Set(existingUnlocks.map((u) => u.achievementId));
  const daysSinceCreation = (Date.now() - new Date(company.createdAt).getTime()) / (1000 * 60 * 60 * 24);

  const reputations = (clientRelations as Array<{ reputation: number }>).map((r) => r.reputation);
  const bestReputation = reputations.length > 0 ? Math.max(...reputations) : 0;
  const clientsEngaged = reputations.filter((r) => r > 0).length;
  const longestLine = (linesForDuration as Array<{ durationMinutes: number }>)
    .reduce((max, l) => Math.max(max, l.durationMinutes), 0);

  /* Plus-values de revente. Le gain est inscrit dans le libellé de l'écriture
     — « (+312 pi.) » — plutôt que dans le montant, qui porte le produit brut
     de la vente. On le relit donc ici, faute de colonne dédiée. */
  const sales = (cargoSales as Array<{ description: string }>).map((t) => {
    const m = t.description.match(/\(([-+]?\d+) pi\.\)$/);
    return m ? Number(m[1]) : 0;
  });
  const bestSale = sales.length > 0 ? Math.max(...sales) : 0;
  const totalSpeculation = sales.reduce((sum, g) => sum + g, 0);
  /* Personnel : depuis la 1.3, on peut avoir plusieurs employés au même poste.
     « Deux postes pourvus » compte donc les POSTES, pas les personnes — trois
     mécaniciens ne font pas une équipe complète. */
  const staffList = staffRows as Array<{ role: string; level: number }>;
  const rolesFilled = new Set(staffList.map((s) => s.role)).size;
  const bestStaffLevel = staffList.reduce((max, s) => Math.max(max, s.level), 0);
  const mechanics = staffList.filter((s) => s.role === "MECANICIEN");
  const mechanicSeats = mechanics.reduce((sum, m) => sum + mechanicCoverage(m.level), 0);
  const trainCount = company._count.trains;

  const lineList = linesForStations as Array<{ departureStation: string; arrivalStation: string }>;
  const servesStation = (name: string) => lineList.some((l) => l.departureStation === name || l.arrivalStation === name);
  const hasLine = (a: string, b: string) =>
    lineList.some((l) => (l.departureStation === a && l.arrivalStation === b) || (l.departureStation === b && l.arrivalStation === a));

  const storedUnits = (stockLots as Array<{ quantity: number }>).reduce((sum, l) => sum + l.quantity, 0);

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
      liveMet: rolesFilled >= 2,
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
      description: "Porter le dépôt à 6 places",
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
      liveMet: rolesFilled >= 3,
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

    /* ---- Ajouts de la 1.2, adossés aux nouveaux systèmes ---- */
    {
      id: "premier-ordre",
      name: "Parole donnée",
      description: "Honorer un premier ordre de donneur d'ordre",
      liveMet: missionsDone >= 1,
    },
    {
      id: "parole-tenue",
      name: "Parole tenue",
      description: "Honorer 10 ordres de donneurs d'ordre",
      liveMet: missionsDone >= 10,
    },
    {
      id: "client-regulier",
      name: "Client régulier",
      description: "Atteindre 30 de réputation chez un chargeur",
      liveMet: bestReputation >= 30,
    },
    {
      id: "affreteur-historique",
      name: "Affréteur historique",
      description: "Porter un chargeur à 100 de réputation",
      liveMet: bestReputation >= 100,
    },
    {
      id: "carnet-rempli",
      name: "Carnet d'adresses",
      description: "Travailler avec les quatre donneurs d'ordre",
      liveMet: clientsEngaged >= 4,
    },
    {
      id: "grande-traversee",
      name: "Grande traversée",
      description: "Exploiter une ligne de 15 minutes ou plus",
      liveMet: longestLine >= 15,
    },
    {
      id: "depot-etendu",
      name: "Dépôt étendu",
      description: "Porter le dépôt à 8 places",
      liveMet: company.maxTrains >= 8,
    },
    {
      id: "baron-du-parc",
      name: "Baron du parc",
      description: "Aligner 10 rames en même temps",
      liveMet: company._count.trains >= 10,
    },
    {
      id: "recruteur-confirme",
      name: "Recruteur confirmé",
      description: "Atteindre le premier palier de parrainage",
      liveMet: company.referralMilestone >= 3,
    },
    {
      id: "commis-dordre",
      name: "Commis d'ordre",
      description: "Encaisser 2 000 pi. de primes de mission",
      liveMet: (missionPayouts?._sum?.amount ?? 0) >= 2000,
    },
    {
      id: "premier-entrepot",
      name: "Sous la halle",
      description: "Faire construire votre entrepôt",
      liveMet: Boolean(warehouse),
    },
    {
      id: "premiere-revente",
      name: "Acheté bas, revendu haut",
      description: "Réaliser une plus-value sur une revente de marchandise",
      liveMet: bestSale > 0,
    },
    {
      id: "beau-coup",
      name: "Le beau coup",
      description: "Gagner 500 pi. sur une seule revente",
      liveMet: bestSale >= 500,
    },
    {
      id: "negociant",
      name: "Négociant",
      description: "Cumuler 5 000 pi. de plus-values sur le marché",
      liveMet: totalSpeculation >= 5000,
    },
    {
      id: "entrepot-plein",
      name: "Entrepôt plein",
      description: "Stocker 50 unités de marchandise en même temps",
      liveMet: storedUnits >= 50,
    },
    {
      id: "batisseur",
      name: "Bâtisseur",
      description: "Mener dix chantiers à leur terme",
      liveMet: constructionsDone >= 10,
    },

    // ---- v1.3 : le réseau s'étend ----
    {
      id: "tour-de-france",
      name: "Tour de France",
      description: "Desservir 15 gares différentes",
      liveMet: distinctStations >= 15,
    },
    {
      id: "maillage-national",
      name: "Maillage national",
      description: "Desservir 30 gares différentes",
      liveMet: distinctStations >= 30,
    },
    {
      id: "finistere",
      name: "Au bout de la terre",
      description: "Desservir Brest",
      liveMet: servesStation("Brest"),
    },
    {
      id: "train-bleu",
      name: "Le Train bleu",
      description: "Ouvrir une ligne entre Paris et Nice",
      liveMet: hasLine("Paris", "Nice"),
    },
    {
      id: "bout-a-bout",
      name: "D'un bout à l'autre",
      description: "Relier Brest et Nice, la plus longue ligne du réseau",
      liveMet: hasLine("Brest", "Nice"),
    },

    // ---- v1.3 : le personnel ----
    {
      id: "bon-patron",
      name: "Bon patron",
      description: "Accorder une première augmentation",
      liveMet: bestStaffLevel >= 2,
    },
    {
      id: "pilier-de-la-maison",
      name: "Pilier de la maison",
      description: "Garder un employé jusqu'au niveau 5",
      liveMet: bestStaffLevel >= 5,
    },
    {
      id: "grand-atelier",
      name: "Grand atelier",
      description: "Employer quatre mécaniciens en même temps",
      liveMet: mechanics.length >= 4,
    },
    {
      id: "flotte-couverte",
      name: "Personne n'est oublié",
      description: "Couvrir une flotte de 8 rames ou plus entièrement par vos mécaniciens",
      liveMet: trainCount >= 8 && mechanicSeats >= trainCount,
    },
    {
      id: "mieux-vaut-prevenir",
      name: "Mieux vaut prévenir",
      description: "Faire réviser 10 rames avant la panne",
      liveMet: preventiveCount >= 10,
    },

    // ---- v1.3 : les grands nombres ----
    {
      id: "gare-de-triage",
      name: "Gare de triage",
      description: "Porter le dépôt à 12 places",
      liveMet: company.maxTrains >= 12,
    },
    {
      id: "coffre-fort",
      name: "Coffre-fort",
      description: "Atteindre 10 000 pièces de trésorerie",
      liveMet: company.balance >= 10_000,
    },
    {
      id: "tresor-de-guerre",
      name: "Trésor de guerre",
      description: "Atteindre 50 000 pièces de trésorerie",
      liveMet: company.balance >= 50_000,
    },
    {
      id: "transporteur",
      name: "Transporteur",
      description: "Livrer 50 contrats de fret",
      liveMet: deliveredCount >= 50,
    },
    {
      id: "roi-du-fret",
      name: "Roi du fret",
      description: "Livrer 250 contrats de fret",
      liveMet: deliveredCount >= 250,
    },
    {
      id: "assidu",
      name: "Assidu",
      description: "Récupérer 30 défis quotidiens",
      liveMet: claimedChallengesCount >= 30,
    },
    {
      id: "cent-jours",
      name: "Cent jours de service",
      description: "Exploiter votre compagnie depuis 100 jours",
      liveMet: daysSinceCreation >= 100,
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
