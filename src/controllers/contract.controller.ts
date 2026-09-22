import { Response } from "express";
import { Prisma } from "@prisma/client";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { requiredCargoTypes } from "../services/mission.service";
import { getCargoIndexMap, freightMultiplier } from "../services/market.service";
import { distanceKm } from "../services/geography.service";

async function getOwnedCompanyOrFail(userId: string) {
  return prisma.company.findUnique({ where: { ownerId: userId } });
}

// Modèles d'offres tirées au sort pour réapprovisionner le marché
const BASE_TEMPLATES = [
  { cargoType: "Céréales", originStation: "Chartres", destinationStation: "Le Mans", durationMinutes: 6, reward: 120, risky: false },
  { cargoType: "Acier", originStation: "Le Creusot", destinationStation: "Dijon", durationMinutes: 8, reward: 180, risky: false },
  { cargoType: "Conteneurs", originStation: "Le Havre", destinationStation: "Rouen", durationMinutes: 4, reward: 90, risky: false },
  { cargoType: "Bois", originStation: "Nancy", destinationStation: "Metz", durationMinutes: 5, reward: 100, risky: false },
  { cargoType: "Automobiles", originStation: "Sochaux", destinationStation: "Mulhouse", durationMinutes: 7, reward: 150, risky: false },
  { cargoType: "Produits chimiques", originStation: "Lyon", destinationStation: "Grenoble", durationMinutes: 6, reward: 140, risky: false },
  // marchandises fragiles : récompense nettement supérieure, mais risque de dommage en cours de route
  { cargoType: "Verre soufflé", originStation: "Nancy", destinationStation: "Strasbourg", durationMinutes: 5, reward: 230, risky: true },
  { cargoType: "Œuvres d'art", originStation: "Paris", destinationStation: "Lyon", durationMinutes: 8, reward: 340, risky: true },
  { cargoType: "Produits pharmaceutiques réfrigérés", originStation: "Strasbourg", destinationStation: "Mulhouse", durationMinutes: 4, reward: 190, risky: true },
];

/* Itinéraires supplémentaires, ouverts avec les nouvelles gares : chaque
   marchandise part désormais de plusieurs régions. La durée vient de la
   distance réelle (comme pour une ligne) et la récompense garde le tarif à la
   minute de la marchandise — un itinéraire plus long paie plus, pas mieux. */
const EXTRA_ROUTES: [string, string, string][] = [
  ["Céréales", "Reims", "Paris"],
  ["Céréales", "Orléans", "Tours"],
  ["Céréales", "Poitiers", "La Rochelle"],
  ["Acier", "Saint-Étienne", "Lyon"],
  ["Acier", "Metz", "Reims"],
  ["Conteneurs", "Marseille", "Avignon"],
  ["Conteneurs", "La Rochelle", "Bordeaux"],
  ["Conteneurs", "Brest", "Rennes"],
  ["Bois", "Limoges", "Poitiers"],
  ["Bois", "Besançon", "Dijon"],
  ["Bois", "Bayonne", "Bordeaux"],
  ["Automobiles", "Rennes", "Nantes"],
  ["Automobiles", "Caen", "Rouen"],
  ["Automobiles", "Clermont-Ferrand", "Lyon"],
  ["Produits chimiques", "Pau", "Toulouse"],
  ["Produits chimiques", "Le Havre", "Paris"],
  ["Verre soufflé", "Troyes", "Reims"],
  ["Œuvres d'art", "Paris", "Nice"],
  ["Œuvres d'art", "Avignon", "Montpellier"],
  ["Produits pharmaceutiques réfrigérés", "Tours", "Orléans"],
  ["Produits pharmaceutiques réfrigérés", "Montpellier", "Perpignan"],
];

const CARGO_TEMPLATES = [
  ...BASE_TEMPLATES,
  ...EXTRA_ROUTES.flatMap(([cargoType, from, to]) => {
    const base = BASE_TEMPLATES.find((t) => t.cargoType === cargoType);
    const km = distanceKm(from, to);
    if (!base || km === null) return [];
    /* Un train de fret roule moins vite qu'un train de voyageurs : son échelle
       est la sienne (≈ 30 km par minute de jeu), bornée de 4 à 14 minutes pour
       rester dans la gamme des contrats existants. */
    const durationMinutes = Math.max(4, Math.min(14, Math.round(km / 30)));
    const perMinute = base.reward / base.durationMinutes;
    return [
      {
        cargoType,
        originStation: from,
        destinationStation: to,
        durationMinutes,
        reward: Math.round((perMinute * durationMinutes) / 5) * 5,
        risky: base.risky,
      },
    ];
  }),
];

// un itinéraire au hasard parmi ceux d'une marchandise
function routeFor(cargoType: string) {
  const routes = CARGO_TEMPLATES.filter((t) => t.cargoType === cargoType);
  return routes[Math.floor(Math.random() * routes.length)];
}

/* Le marché est commun à tout le réseau : on le garnit pour le plus exigeant
   des joueurs connectés. Un abonné voit six offres, un gratuit les trois plus
   anciennes — plus de choix, pas de meilleur tarif. */
const MIN_MARKET_SIZE = 3;
const PREMIUM_MARKET_SIZE = 6;
const EXPIRY_MINUTES = 5; // durée de vie d'une offre non acceptée sur le marché

export async function removeExpiredContracts() {
  await prisma.contract.deleteMany({
    where: { status: "DISPONIBLE", companyId: null, expiresAt: { lt: new Date() } },
  });
}

export async function ensureMarketStocked() {
  const availableContracts = await prisma.contract.findMany({
    where: { status: "DISPONIBLE", companyId: null },
    select: { cargoType: true },
  });
  const presentTypes = new Set(availableContracts.map((c) => c.cargoType));

  /* Marchandises réclamées par un ordre de mission en cours et absentes du
     marché. Sans cette garantie, un joueur peut accepter un ordre portant sur
     de l'acier et ne jamais voir un seul contrat d'acier — il perdrait de la
     réputation sans avoir commis la moindre erreur. */
  const wanted = [...(await requiredCargoTypes())].filter(
    (t) => !presentTypes.has(t) && CARGO_TEMPLATES.some((c) => c.cargoType === t)
  );

  /* Le marché s'étend au-delà de son minimum si des ordres attendent une
     marchandise : un marché « plein » d'autre chose bloquerait les missions. */
  const toCreate = Math.max(PREMIUM_MARKET_SIZE - availableContracts.length, wanted.length);
  if (toCreate <= 0) return;

  type CargoTemplate = (typeof CARGO_TEMPLATES)[number];

  for (let i = 0; i < toCreate; i++) {
    let template: CargoTemplate | undefined;

    // les marchandises réclamées passent d'abord
    while (wanted.length > 0 && !template) {
      const need = wanted.shift() as string;
      template = routeFor(need);
    }

    if (!template) {
      // on évite de proposer un modèle de marchandise déjà visible sur le marché,
      // pour ne pas donner l'impression que les offres se dupliquent
      /* On tire d'abord la marchandise, puis l'itinéraire : une marchandise à
         quatre itinéraires ne doit pas sortir quatre fois plus souvent. */
      const types = [...new Set(BASE_TEMPLATES.map((t) => t.cargoType))];
      const pool = types.filter((t) => !presentTypes.has(t));
      const candidates = pool.length > 0 ? pool : types;
      template = routeFor(candidates[Math.floor(Math.random() * candidates.length)]);
    }

    presentTypes.add(template.cargoType);

    await prisma.contract.create({
      data: { ...template, expiresAt: new Date(Date.now() + EXPIRY_MINUTES * 60_000) },
    });
  }
}

export async function listMarket(req: AuthRequest, res: Response) {
  await removeExpiredContracts();
  await ensureMarketStocked();

  const company = await prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { isPremium: true },
  });

  const contracts = await prisma.contract.findMany({
    where: { status: "DISPONIBLE", companyId: null },
    orderBy: { createdAt: "asc" },
    take: company?.isPremium ? PREMIUM_MARKET_SIZE : MIN_MARKET_SIZE,
  });

  /* Le cours du jour est joint à chaque offre : sans lui, le joueur devrait
     ouvrir une autre page pour savoir si la marchandise proposée paie
     au-dessus ou en dessous de sa valeur normale. */
  const index = await getCargoIndexMap();
  const withPrices = contracts.map((c: { cargoType: string; reward: number }) => {
    const i = index.get(c.cargoType);
    const multiplier = i === undefined ? 1 : freightMultiplier(i);
    return {
      ...c,
      marketIndex: i === undefined ? null : Number(i.toFixed(3)),
      // récompense réellement attendue, cours compris — c'est ce chiffre qui décide
      effectiveReward: Math.round(c.reward * multiplier),
      marketDelta: Math.round((multiplier - 1) * 100),
    };
  });

  return res.json(withPrices);
}

export async function listMyContracts(req: AuthRequest, res: Response) {
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const contracts = await prisma.contract.findMany({
    where: { companyId: company.id },
    include: { train: true },
    orderBy: { createdAt: "desc" },
  });

  return res.json(contracts);
}

const INSURANCE_PREMIUM_RATIO = 0.15; // 15% de la récompense, payé d'avance, non remboursable

export async function acceptContract(req: AuthRequest, res: Response) {
  const { contractId, trainId, insured } = req.body;

  if (!contractId || !trainId) {
    return res.status(400).json({ error: "contractId et trainId sont requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const contract = await prisma.contract.findUnique({ where: { id: contractId } });
  if (!contract || contract.status !== "DISPONIBLE" || contract.companyId) {
    return res.status(409).json({ error: "Ce contrat n'est plus disponible" });
  }
  if (contract.expiresAt && contract.expiresAt < new Date()) {
    await prisma.contract.delete({ where: { id: contractId } });
    return res.status(409).json({ error: "Ce contrat vient d'expirer" });
  }

  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) {
    return res.status(404).json({ error: "Train introuvable" });
  }
  if (train.status !== "IDLE" || train.lineId) {
    return res.status(409).json({ error: "Ce train n'est pas disponible (déjà en service)" });
  }
  if (train.wear >= 100) {
    return res.status(409).json({ error: "Ce train doit être réparé avant de pouvoir circuler" });
  }

  const wantsInsurance = Boolean(insured);
  if (wantsInsurance && !contract.risky) {
    return res.status(400).json({ error: "Seules les cargaisons fragiles peuvent être assurées" });
  }

  const premium = wantsInsurance ? Math.round(contract.reward * INSURANCE_PREMIUM_RATIO) : 0;
  if (wantsInsurance && company.balance < premium) {
    return res.status(409).json({ error: `Trésorerie insuffisante pour la prime d'assurance (${premium} pièces)` });
  }

  const updates: Prisma.PrismaPromise<any>[] = [
    prisma.contract.update({
      where: { id: contractId },
      data: { companyId: company.id, trainId, status: "EN_COURS", acceptedAt: new Date(), insured: wantsInsurance },
    }),
    prisma.train.update({
      where: { id: trainId },
      data: { status: "EN_ROUTE", progress: 0, departedAt: new Date() },
    }),
  ];

  if (wantsInsurance) {
    updates.push(
      prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: premium } } }),
      prisma.transaction.create({
        data: {
          companyId: company.id,
          type: "FRET",
          amount: -premium,
          description: `Prime d'assurance : ${contract.cargoType}`,
          trainId,
        },
      })
    );
  }

  const [updatedContract] = await prisma.$transaction(updates);

  return res.status(201).json(updatedContract);
}
