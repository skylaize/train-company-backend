import { clientById } from "../services/client.service";
import { Response } from "express";
import { Prisma } from "@prisma/client";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { isNewcomer, WELCOME_WAGON } from "../services/newcomer.service";
import { requiredCargoTypes } from "../services/mission.service";
import { campaignFreightStations } from "../services/campaign.service";
import { getCargoIndexMap, freightMultiplier } from "../services/market.service";
import { distanceKm } from "../services/geography.service";
import { brokenRegions, eruptionActive, eruptionConfig, ELECTRIC_CARGO, ERUPTION_REGIONS, routeEruption } from "../services/eruption.service";
import { yardsOf, YARD_TIME } from "../services/infrastructure.service";
import { loadCheck, loadFactorFor, tourMinutes, isFreightModel, isWagon, wagonFor } from "../services/freight.service";

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
  // 2.5.1 : les Hauts-de-France n'avaient aucun itinéraire de fret
  ["Céréales", "Amiens", "Paris"],
  ["Acier", "Lille", "Reims"],
  ["Conteneurs", "Lille", "Amiens"],
  ["Automobiles", "Amiens", "Rouen"],
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

/* ---------------- 2.3 : le conteneur scellé ----------------

   De temps en temps, un conteneur scellé arrive sur le marché : contenu
   inconnu, prix d'or. Un seul à la fois pour tout le réseau, premier arrivé
   premier servi. On découvre ce qu'il y avait dedans à la livraison (voir
   sealedOutcome dans la simulation). */
export const SEALED_CARGO = "Conteneur scellé";
const SEALED_CHANCE = 0.006; // par tour de 30 s quand il n'y en a pas : un toutes les quarante minutes environ
const SEALED_EXPIRY_MINUTES = 10;
const SEALED_RATE = 2.2; // le tarif à la minute d'un conteneur ordinaire, multiplié

async function maybeOfferSealed() {
  // 2.7 : pendant l'éruption solaire, le matériel électrique remplace le conteneur scellé
  if (eruptionActive()) return;
  if (Math.random() >= SEALED_CHANCE) return;
  const already = await prisma.contract.count({ where: { sealed: true, status: "DISPONIBLE", companyId: null } });
  if (already > 0) return;
  const routes = CARGO_TEMPLATES.filter((t) => t.durationMinutes >= 5);
  const r = routes[Math.floor(Math.random() * routes.length)];
  const base = BASE_TEMPLATES.find((t) => t.cargoType === "Conteneurs")!;
  const perMinute = (base.reward / base.durationMinutes) * SEALED_RATE;
  await prisma.contract.create({
    data: {
      cargoType: SEALED_CARGO,
      originStation: r.originStation,
      destinationStation: r.destinationStation,
      durationMinutes: r.durationMinutes,
      reward: Math.round((perMinute * r.durationMinutes) / 5) * 5,
      risky: false,
      sealed: true,
      expiresAt: new Date(Date.now() + SEALED_EXPIRY_MINUTES * 60_000),
    },
  });
}

/* ---------------- 2.7 : le matériel électrique ----------------

   Pendant l'éruption solaire, des conteneurs de matériel électrique
   attendent sur le marché, livrés dans une région en panne. Payés comme des
   conteneurs, ils donnent en plus un point de réparation des sous-stations.
   Quelques-uns à la fois pour tout le réseau, réassortis au fil des tours. */
const ELECTRIC_EXPIRY_MINUTES = 10;
const FRANCE_STATIONS = ERUPTION_REGIONS.flatMap((r) => r.stations);

async function maybeOfferElectric() {
  const cfg = eruptionConfig();
  if (!cfg || !eruptionActive()) return;
  const targets = brokenRegions();
  if (!targets.length || Math.random() >= cfg.containerChance) return;
  const open = await prisma.contract.count({ where: { electric: true, status: "DISPONIBLE", companyId: null } });
  if (open >= cfg.containersOpen) return;
  const region = ERUPTION_REGIONS.find((r) => r.id === targets[Math.floor(Math.random() * targets.length)])!;
  const to = region.stations[Math.floor(Math.random() * region.stations.length)];
  // un départ à distance raisonnable, hors de la région
  const froms = FRANCE_STATIONS.filter((st) => !region.stations.includes(st)).filter((st) => {
    const km = distanceKm(st, to);
    return km !== null && km >= 80 && km <= 420;
  });
  const from = froms[Math.floor(Math.random() * froms.length)];
  if (!from) return;
  const km = distanceKm(from, to) ?? 150;
  const durationMinutes = Math.max(4, Math.min(14, Math.round(km / 30)));
  const base = BASE_TEMPLATES.find((t) => t.cargoType === "Conteneurs")!;
  await prisma.contract.create({
    data: {
      cargoType: ELECTRIC_CARGO,
      originStation: from,
      destinationStation: to,
      durationMinutes,
      reward: Math.round(((base.reward / base.durationMinutes) * durationMinutes) / 5) * 5,
      risky: false,
      electric: true,
      expiresAt: new Date(Date.now() + ELECTRIC_EXPIRY_MINUTES * 60_000),
    },
  });
}

export async function removeExpiredContracts() {
  await prisma.contract.deleteMany({
    // 2.4 : même grâce de 30 s qu'à l'acceptation, sinon l'offre disparaîtrait pendant le clic
    where: { status: "DISPONIBLE", companyId: null, expiresAt: { lt: new Date(Date.now() - 30_000) } },
  });
}

/* 2.5.1 : une offre au moins pour chaque région dont une campagne attend du fret */
async function ensureCampaignFreight() {
  const regions = await campaignFreightStations();
  if (!regions.size) return;
  const open = (await prisma.contract.findMany({
    where: { status: "DISPONIBLE", companyId: null, sealed: false, electric: false, reservedFor: null },
    select: { originStation: true, destinationStation: true },
  })) as { originStation: string; destinationStation: string }[];
  for (const stations of regions.values()) {
    const touches = (t: { originStation: string; destinationStation: string }) => stations.includes(t.originStation) || stations.includes(t.destinationStation);
    if (open.some(touches)) continue;
    const routes = CARGO_TEMPLATES.filter(touches);
    if (!routes.length) continue;
    const t = routes[Math.floor(Math.random() * routes.length)];
    await prisma.contract.create({ data: { ...t, expiresAt: new Date(Date.now() + EXPIRY_MINUTES * 60_000) } });
    open.push(t);
  }
}

export async function ensureMarketStocked() {
  await maybeOfferSealed().catch((err) => console.error("[fret] conteneur scellé :", (err as Error).message));
  await maybeOfferElectric().catch((err) => console.error("[fret] matériel électrique :", (err as Error).message));
  await ensureCampaignFreight().catch((err) => console.error("[fret] campagnes :", (err as Error).message));
  const availableContracts = await prisma.contract.findMany({
    where: { status: "DISPONIBLE", companyId: null, sealed: false, electric: false, reservedFor: null },
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

/* 2.0 : pour chaque marchandise, l'ordre de donneur d'ordre que la prochaine
   livraison fera avancer (le plus ancien accepté). Affiché sur la page du fret,
   pour savoir d'un coup d'œil quel contrat sert à quel ordre. */
async function ordersByCargo(companyId: string) {
  const missions = (await prisma.mission.findMany({
    where: { companyId, status: "ACCEPTEE" },
    orderBy: { createdAt: "asc" },
    select: { id: true, clientId: true, cargoType: true, progress: true, target: true },
  })) as { id: string; clientId: string; cargoType: string; progress: number; target: number }[];
  const map = new Map<string, { ref: string; client: string; progress: number; target: number; more: number }>();
  for (const m of missions) {
    const cur = map.get(m.cargoType);
    if (cur) {
      cur.more += 1;
      continue;
    }
    map.set(m.cargoType, {
      ref: `${m.clientId.slice(0, 2)}-${m.id.slice(0, 4).toUpperCase()}`,
      client: clientById(m.clientId)?.name ?? m.clientId,
      progress: m.progress,
      target: m.target,
      more: 0,
    });
  }
  return map;
}

/* ---------------- 2.6.1 : le contrat de bienvenue ----------------
   Le fret était l'étape où les nouveaux décrochaient : un Locotracteur, une
   offre qui expire en cinq minutes, le bon wagon à atteler. Une compagnie de
   moins de sept jours qui n'a encore rien livré trouve donc sur le marché une
   offre réservée pour elle, valable 24 h, payée moitié plus, sur un wagon
   plat — celui que son premier Locotracteur reçoit en cadeau (train.controller). */
const WELCOME_HOURS = 24;

async function ensureWelcomeContract(company: { id: string; createdAt: Date }) {
  if (!(await isNewcomer(company.id, company.createdAt))) return;
  // une seule à la fois, et pas pendant qu'une tournée roule déjà
  const pending = await prisma.contract.count({
    where: { OR: [{ reservedFor: company.id, status: "DISPONIBLE" }, { companyId: company.id, status: "EN_COURS" }] },
  });
  if (pending) return;
  const lines = (await prisma.line.findMany({ where: { companyId: company.id }, select: { departureStation: true, arrivalStation: true, stops: true } })) as {
    departureStation: string; arrivalStation: string; stops: string[];
  }[];
  const mine = new Set(lines.flatMap((l) => [l.departureStation, ...(l.stops ?? []), l.arrivalStation]));
  const flat = CARGO_TEMPLATES.filter((t) => wagonFor(t.cargoType) === WELCOME_WAGON);
  const near = flat.filter((t) => mine.has(t.originStation) || mine.has(t.destinationStation));
  const pool = near.length ? near : flat;
  if (!pool.length) return;
  const t = pool[Math.floor(Math.random() * pool.length)];
  await prisma.contract.create({
    data: { ...t, reward: Math.round((t.reward * 1.5) / 5) * 5, risky: false, reservedFor: company.id, expiresAt: new Date(Date.now() + WELCOME_HOURS * 3_600_000) },
  });
}

export async function listMarket(req: AuthRequest, res: Response) {
  await removeExpiredContracts();
  await ensureMarketStocked();

  const company = await prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true, isPremium: true, createdAt: true },
  });
  const orders = company ? await ordersByCargo(company.id) : new Map();
  if (company) await ensureWelcomeContract(company).catch((err) => console.error("[fret] contrat de bienvenue :", (err as Error).message));

  const contracts = [
    // 2.6.1 : le contrat de bienvenue, en tête
    ...(company ? await prisma.contract.findMany({ where: { status: "DISPONIBLE", companyId: null, reservedFor: company.id } }) : []),
    // 2.3 : le conteneur scellé passe devant, pour tout le monde
    ...(await prisma.contract.findMany({ where: { status: "DISPONIBLE", companyId: null, sealed: true, reservedFor: null } })),
    // 2.7 : le matériel électrique aussi, pour tout le monde
    ...(await prisma.contract.findMany({ where: { status: "DISPONIBLE", companyId: null, electric: true }, orderBy: { createdAt: "asc" } })),
    ...(await prisma.contract.findMany({
      where: { status: "DISPONIBLE", companyId: null, sealed: false, electric: false, reservedFor: null },
      orderBy: { createdAt: "asc" },
      take: company?.isPremium ? PREMIUM_MARKET_SIZE : MIN_MARKET_SIZE,
    })),
  ];
  /* 2.5.1 : la campagne en cours attend du fret de sa région : l'offre qui la
     concerne s'ajoute à la liste, même si elle est plus récente que les autres */
  if (company) {
    const mine = [...(await campaignFreightStations(company.id)).values()].flat();
    const touches = (c: { originStation: string; destinationStation: string }) => mine.includes(c.originStation) || mine.includes(c.destinationStation);
    if (mine.length && !(contracts as { originStation: string; destinationStation: string }[]).some(touches)) {
      const extra = await prisma.contract.findFirst({
        where: { status: "DISPONIBLE", companyId: null, sealed: false, electric: false, reservedFor: null, OR: [{ originStation: { in: mine } }, { destinationStation: { in: mine } }] },
        orderBy: { createdAt: "asc" },
      });
      if (extra) contracts.push(extra);
    }
  }

  /* Le cours du jour est joint à chaque offre : sans lui, le joueur devrait
     ouvrir une autre page pour savoir si la marchandise proposée paie
     au-dessus ou en dessous de sa valeur normale. */
  const index = await getCargoIndexMap();
  const now = Date.now();
  const withPrices = contracts.map((c: { cargoType: string; reward: number; expiresAt: Date | null }) => {
    const i = index.get(c.cargoType);
    const multiplier = i === undefined ? 1 : freightMultiplier(i);
    return {
      ...c,
      marketIndex: i === undefined ? null : Number(i.toFixed(3)),
      // récompense réellement attendue, cours compris — c'est ce chiffre qui décide
      effectiveReward: Math.round(c.reward * multiplier),
      marketDelta: Math.round((multiplier - 1) * 100),
      forOrder: orders.get(c.cargoType) ?? null,
      wagon: wagonFor(c.cargoType), // 2.1 : le wagon qui la transporte
      /* 2.4 : temps restant calculé par le serveur. Le compte à rebours du
         jeu partait de l'heure du téléphone : une horloge en retard de
         quelques minutes affichait « expire dans 3:35 » sur une offre déjà
         périmée pour le serveur, et le départ était refusé. */
      expiresInMs: c.expiresAt ? Math.max(0, new Date(c.expiresAt).getTime() - now) : null,
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
  const orders = await ordersByCargo(company.id);

  return res.json(
    (contracts as { status: string; cargoType: string }[]).map((c) => ({ ...c, forOrder: c.status === "EN_COURS" ? orders.get(c.cargoType) ?? null : null }))
  );
}

const INSURANCE_PREMIUM_RATIO = 0.15; // 15% de la récompense, payé d'avance, non remboursable

/* 2.1 : accepter un contrat, ou une tournée de plusieurs contrats sur une
   même rame (un par type de wagon). Corps : { trainId, contractIds: string[],
   insuredIds?: string[] } ; l'ancien { trainId, contractId, insured } marche encore. */
export async function acceptContract(req: AuthRequest, res: Response) {
  const { trainId } = req.body ?? {};
  const ids: string[] = Array.isArray(req.body?.contractIds)
    ? [...new Set((req.body.contractIds as unknown[]).map(String))]
    : req.body?.contractId
    ? [String(req.body.contractId)]
    : [];
  const insuredIds = new Set<string>(
    Array.isArray(req.body?.insuredIds) ? (req.body.insuredIds as unknown[]).map(String) : req.body?.insured && req.body?.contractId ? [String(req.body.contractId)] : []
  );

  if (ids.length === 0 || !trainId) {
    return res.status(400).json({ error: "trainId et au moins un contrat sont requis" });
  }
  if (ids.length > 6) return res.status(400).json({ error: "Six contrats au plus par tournée" });

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const contracts = (await prisma.contract.findMany({ where: { id: { in: ids } } })) as {
    id: string; status: string; companyId: string | null; expiresAt: Date | null; cargoType: string; risky: boolean; reward: number; durationMinutes: number; originStation: string; destinationStation: string;
  }[];
  if (contracts.length !== ids.length || contracts.some((c) => c.status !== "DISPONIBLE" || c.companyId || ((c as { reservedFor?: string | null }).reservedFor && (c as { reservedFor?: string | null }).reservedFor !== company.id))) {
    // 2.4 : le marché est commun à tous les joueurs, un autre a pu le prendre entre-temps
    return res.status(409).json({ error: ids.length > 1 ? "Un des contrats vient d'être pris par une autre compagnie ou a expiré : la liste est mise à jour" : "Ce contrat vient d'être pris par une autre compagnie ou a expiré : la liste est mise à jour" });
  }
  /* 2.4 : 30 secondes de grâce, le temps que le clic arrive au serveur (une
     offre affichée « 0:05 » sur un téléphone en 4G ne doit pas être refusée) */
  const expired = contracts.filter((c) => c.expiresAt && new Date(c.expiresAt).getTime() < Date.now() - 30_000);
  if (expired.length) {
    await prisma.contract.deleteMany({ where: { id: { in: expired.map((c) => c.id) } } });
    return res.status(409).json({ error: expired.length > 1 ? "Des contrats viennent d'expirer : la liste est mise à jour" : "Ce contrat vient d'expirer : la liste est mise à jour" });
  }

  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) {
    return res.status(404).json({ error: "Train introuvable" });
  }
  if (train.status !== "IDLE" || train.lineId) {
    return res.status(409).json({ error: "Ce train n'est pas disponible (déjà en service)" });
  }
  if (train.model === "COUCHETTES" || train.model === "LUXE") {
    return res.status(409).json({ error: `Une rame ${train.model === "LUXE" ? "de grand luxe" : "couchettes"} transporte des voyageurs, pas du fret` });
  }
  if (train.wear >= 100) {
    return res.status(409).json({ error: "Ce train doit être réparé avant de pouvoir circuler" });
  }

  // 2.1 : les wagons décident de ce que la rame peut charger
  const why = loadCheck(train, contracts.map((c) => c.cargoType));
  if (why) return res.status(409).json({ error: why });
  // 2.7 : pas de départ électrique vers une région où le courant est coupé
  if (train.model === "FRET_ELECTRIQUE" && routeEruption(contracts.flatMap((c) => [c.originStation, c.destinationStation]))?.status === "coupee") {
    return res.status(409).json({ error: "Le courant est coupé sur ce trajet (éruption solaire) : prenez une locomotive diesel, locotracteur, fret lourd ou messagerie rapide" });
  }

  for (const id of insuredIds) {
    const c = contracts.find((x) => x.id === id);
    if (c && !c.risky) return res.status(400).json({ error: "Seules les cargaisons fragiles peuvent être assurées" });
  }
  const premium = contracts.filter((c) => insuredIds.has(c.id)).reduce((s, c) => s + Math.round(c.reward * INSURANCE_PREMIUM_RATIO), 0);
  if (premium > 0 && company.balance < premium) {
    return res.status(409).json({ error: `Trésorerie insuffisante pour la prime d'assurance (${premium} pièces)` });
  }

  // 2.1 : l'allure de la locomotive et le poids des wagons font la durée de la tournée
  /* 2.1 : une gare de triage au départ ou à l'arrivée d'un contrat raccourcit
     sa part de la tournée */
  const yards = await yardsOf(company.id);
  const durations = contracts.map((c) => Math.round(c.durationMinutes * (yards.has(c.originStation) || yards.has(c.destinationStation) ? YARD_TIME : 1)));
  const tour = isFreightModel(train.model)
    ? tourMinutes(train.model, durations, (train.cars ?? []).filter((c: string) => isWagon(c)).length)
    : null;
  const now = new Date();
  /* 2.3 : tout se joue en une transaction conditionnelle. Avant, deux
     acceptations simultanées du même contrat (deux joueurs, ou un double clic
     avec deux locomotives) passaient toutes les deux la vérification : la
     seconde reprenait le contrat, et la première locomotive restait « en
     tournée » sans rien à livrer, pour toujours. */
  class Taken extends Error {}
  let done: unknown[];
  try {
    done = await prisma.$transaction(async (tx) => {
      const claimed = await tx.train.updateMany({
        where: { id: trainId, companyId: company.id, status: "IDLE", lineId: null },
        data: { status: "EN_ROUTE", progress: 0, departedAt: now },
      });
      if (claimed.count !== 1) throw new Taken("Ce train n'est pas disponible (déjà en service)");
      const out: unknown[] = [];
      for (const c of contracts) {
        const hit = await tx.contract.updateMany({
          where: { id: c.id, status: "DISPONIBLE", companyId: null },
          data: {
            companyId: company.id,
            trainId,
            status: "EN_COURS",
            acceptedAt: now,
            insured: insuredIds.has(c.id),
            tourMinutes: tour,
            loadFactor: loadFactorFor(train, c.cargoType),
          },
        });
        if (hit.count !== 1) throw new Taken(contracts.length > 1 ? "Un des contrats vient d'être pris par une autre rame" : "Ce contrat vient d'être pris par une autre rame");
        out.push(await tx.contract.findUnique({ where: { id: c.id } }));
      }
      if (premium > 0) {
        await tx.company.update({ where: { id: company.id }, data: { balance: { decrement: premium } } });
        await tx.transaction.create({
          data: {
            companyId: company.id,
            type: "FRET",
            amount: -premium,
            description: `Prime d'assurance : ${contracts.filter((c) => insuredIds.has(c.id)).map((c) => c.cargoType).join(", ")}`,
            trainId,
          },
        });
      }
      return out;
    });
  } catch (err) {
    if (err instanceof Taken) return res.status(409).json({ error: err.message });
    throw err;
  }

  return res.status(201).json(contracts.length === 1 ? done[0] : { ok: true, contracts: done, tourMinutes: tour });
}
