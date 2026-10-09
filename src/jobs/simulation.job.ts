import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { ensureMarketStocked, removeExpiredContracts } from "../controllers/contract.controller";
import { processReferralMilestones } from "../services/referral-milestone.service";
import { creditDelivery, expireMissions } from "../services/mission.service";
import { cargoBonus } from "../services/client.service";
import { upkeepPerTick } from "../services/upkeep.service";
import { computeReputation } from "../services/reputation.service";
import { runMarketTick, runStorageFees, getCargoIndexMap, freightMultiplier } from "../services/market.service";
import { completeConstructions } from "../services/construction.service";
import { runMorningDigest } from "../services/report.service";
import { activeStationEvents, competitionMap, routeDemand, routeHasBoost, maybeSpawnStationEvent, pairKey, watchCompetition } from "../services/station.service";
import { routeOf, routeInDirection } from "../services/route.service";
import { passengersPerDeparture, tripLoad, speedFactor } from "../services/ridership.service";
import { stationOwners, stationEffects, accruePending, payStationIncome, workshopsByCompany, WORKSHOP_WEAR, ELECTRIC_SPEED, ELECTRIC_WEAR } from "../services/infrastructure.service";
import { runLoanPayments, runSharePrices, runDividends, runWeeklyReports, runStockOrders, runPremiumAlerts } from "../services/finance.service";
import { runAutoPricing } from "../services/pricing.service";
import { sendToCompany } from "../services/push.service";
import { seasonalStationEvents } from "../services/season.service";
import { allStationCounts, hubMultiplier } from "../services/hub.service";
import { runTenders } from "../services/tender.service";
import { runDecisions, activeDecisionEffects, decisionMultiplier } from "../services/decision.service";
import { isInternational, INTL_REVENUE_BONUS, TOLL_RATE } from "../services/international.service";
import { isNightService, NIGHT_MULTIPLIER, DAY_COUCHETTES_MULTIPLIER } from "../services/time.service";
import { peakFactor, PEAK_HOURS } from "../services/peak.service";
import { allianceMap, alliesOf, allyMultiplier } from "../services/alliance.service";
import { contribute, flushWorld, TUNNEL_NAME, TUNNEL_STATIONS } from "../services/world.service";
import { addSeasonPoints, seasonEvent, flushSeason, runSeasons, notifySeasonEnd, POINTS } from "../services/saison.service";
import { parisHour } from "../services/time.service";
let lastPricingHour = -1;
import { checkPriceAlerts, runStandingOrders } from "../controllers/market.controller";
import { DLC_MODELS, MOUNTAIN_STATIONS, MOUNTAIN_WEAR, mountainDemand, isWeekend } from "../services/dlc.service";
import { runWrecks, heritageOf, HERITAGE_WEAR } from "../services/wreck.service";
import { reconcilePayments } from "../controllers/billing.controller";
import { refreshWeather, weatherMap, routeWeather, StationWeather } from "../services/realweather.service";
import {
  NEGLECT_FROM, NEGLECT_CHANCE, TRACK_INCIDENT_CHANCE, TRACK_INCIDENTS, SERVICE_DISCOUNT, PARTS,
  organBias, weakestOrgan, freshBias, breakdownData, readStock, takeFromStock, partPrice, partDelayMs, serviceMinutes, runWorkshop, Organ,
} from "../services/workshop.service";
import { crewByTrain, controllerBonus, driverEffects } from "../services/crew.service";
import { staffEffectsByCompany, runStaffExperience, repairCostPerPoint, staffEffectsFor, CompanyStaffEffects, WEAR_PER_TICK } from "../services/staff.service";

/* Arrondi aléatoire : 1,72 donne 2 dans 72 % des cas et 1 dans les autres.
   L'usure est stockée en entier ; un arrondi classique ramenait tout taux
   entre 1,5 et 2 à 2, si bien qu'un mécanicien partiellement efficace — ou un
   mécanicien par canicule (1 × 1,5 = 1,5) — n'avait strictement aucun effet.
   Ici, la moyenne sur la durée est exactement le taux voulu. */
function stochasticRound(x: number) {
  const f = Math.floor(x);
  return f + (Math.random() < x - f ? 1 : 0);
}

const NO_STAFF: CompanyStaffEffects = { wearMultiplier: 1, repairMultiplier: 1, revenueMultiplier: 1 };

// Tourne toutes les 30 secondes. Deux types de trajets sont gérés :
// - Ligne voyageurs : service continu, le train repart aussitôt arrivé.
// - Contrat de fret : trajet unique, le train est libéré et la récompense
//   versée à la compagnie une fois la livraison terminée.
// Le marché de contrats est aussi réapprovisionné à chaque tick.

const TICK_INTERVAL_MS = 30_000;

export function startSimulationJob() {
  /* Le tick est une fonction async lancée par setInterval : personne n'attend
     la promesse qu'elle renvoie. Sans ce filet, la moindre erreur — une
     coupure de la base, une table absente parce qu'une migration n'a pas été
     jouée — devient un rejet non intercepté, et Node arrête le processus. Le
     serveur entier tombait donc pour une requête ratée, et redémarrait en
     boucle toutes les trente secondes.

     On journalise et on laisse passer : le tour suivant retentera. */
  /* Un tour qui dépasse 30 s (base lente, beaucoup de rames) ne doit pas se
     superposer au suivant : deux tours en parallèle paieraient deux fois les
     mêmes arrivées. Le suivant attend donc la fin du précédent. */
  let ticking = false;
  setInterval(() => {
    if (ticking) {
      console.warn("[simulation] tour précédent encore en cours, celui-ci est sauté");
      return;
    }
    ticking = true;
    const started = Date.now();
    holdLease()
      .then((mine) => (mine ? runSimulationTick() : undefined))
      .then(() => {
        // 2.0 : un tour lent se voit dans les journaux de Coolify
        const ms = Date.now() - started;
        if (ms > 8000) console.warn(`[simulation] tour lent : ${(ms / 1000).toFixed(1)} s`);
      })
      .catch((err) => {
        console.error("[simulation] tour ignoré après erreur :", err);
      })
      .finally(() => {
        ticking = false;
      });
  }, TICK_INTERVAL_MS);
  console.log("Simulation du réseau démarrée (tick toutes les 30s)");
}

/* 1.7.2 : un seul serveur à la fois fait tourner la simulation.

   Pendant un déploiement (Coolify lance le nouveau conteneur avant d'arrêter
   l'ancien), deux processus se partageaient la même base et jouaient chacun
   leur tour : salaires et entretien prélevés deux fois, et une trésorerie qui
   tombait à zéro faisait partir le personnel. Le serveur qui tient le bail le
   renouvelle à chaque tour ; un autre ne le prend que s'il a expiré. */
const LEASE_HOLDER = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const LEASE_MS = 75_000; // deux tours et demi : un tour lent ne fait pas perdre le bail
let leaseWarned = false;

async function holdLease(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<{ holder: string }[]>`
      INSERT INTO "SimLease" ("id", "holder", "until")
      VALUES (1, ${LEASE_HOLDER}, NOW() + (${LEASE_MS} * INTERVAL '1 millisecond'))
      ON CONFLICT ("id") DO UPDATE
        SET "holder" = EXCLUDED."holder", "until" = EXCLUDED."until"
        WHERE "SimLease"."holder" = EXCLUDED."holder" OR "SimLease"."until" < NOW()
      RETURNING "holder"`;
    const mine = rows.length > 0 && rows[0].holder === LEASE_HOLDER;
    if (!mine && !leaseWarned) {
      console.log("[simulation] un autre serveur fait déjà tourner la simulation, celui-ci attend");
      leaseWarned = true;
    }
    if (mine) leaseWarned = false;
    return mine;
  } catch (err) {
    // table absente (migration pas encore jouée) : on tourne comme avant
    console.error("[simulation] bail indisponible :", (err as Error).message);
    return true;
  }
}

/* Une rame « en panne » ne peut pas avoir moins de 100 % d'usure : si une
   écriture concurrente l'a laissée ainsi, on la remet en service. */
async function healStuckTrains() {
  await prisma.train.updateMany({
    where: { status: "MAINTENANCE", wear: { lt: 100 }, lineId: { not: null }, workshopUntil: null, partsEta: null, brokenPart: null },
    data: { status: "EN_ROUTE", progress: 0, departedAt: new Date() },
  });
  await prisma.train.updateMany({
    where: { status: "MAINTENANCE", wear: { lt: 100 }, lineId: null, workshopUntil: null, partsEta: null, brokenPart: null },
    data: { status: "IDLE", progress: 0, departedAt: null },
  });
}

// les paliers de parrainage bougent lentement : inutile de les recalculer
// toutes les 30 secondes, un passage toutes les 5 minutes suffit
let tickCount = 0;
const MILESTONE_EVERY = 10;

async function runSimulationTick() {
  tickCount += 1;
  // 2.0 : la vraie météo des gares, relevée toutes les 20 minutes (sans bloquer le tour)
  // 2.0 : paiements livrés même si le webhook Stripe s'est perdu
  void reconcilePayments().catch((err) => console.error("[stripe] rattrapage :", (err as Error).message));
  void refreshWeather().catch((err) => console.error("[météo] échec :", (err as Error).message));
  // gares : un événement naît de temps en temps, annoncé une heure à l'avance
  await maybeSpawnStationEvent().catch((err) => console.error("[gares] échec :", (err as Error).message));
  const weather = await weatherMap().catch(() => new Map<string, StationWeather>());
  await runLineTrains(weather);
  await runFreightContracts(weather);
  await runPayroll();
  await runStaffExperience();
  // 2.0 : sorties d'atelier et pièces livrées
  await runWorkshop().catch((err) => console.error("[atelier] échec :", (err as Error).message));
  await runWrecks().catch((err) => console.error("[épaves] échec :", (err as Error).message));
  if (tickCount % 10 === 2) await healStuckTrains().catch((err) => console.error("[rames] échec :", (err as Error).message));
  await runUpkeep();
  // avant de réapprovisionner : les ordres périmés libèrent leur marchandise
  await expireMissions();
  await removeExpiredContracts();
  await ensureMarketStocked();
  await processReferralRewards();
  /* Cours du fret : le marché bouge que le joueur soit là ou non, sinon
     spéculer reviendrait à jouer contre une horloge qu'on met en pause soi-même. */
  await runMarketTick();
  await runStorageFees();
  await checkPriceAlerts();
  await runStandingOrders();
  // chantiers arrivés à terme : dépôt agrandi, entrepôt livré
  await completeConstructions();
  // appels d'offres (1.5) : annonce, ouverture, attribution, subventions, clôture
  await runTenders(async (companyId, title, body) => {
    await sendToCompany(companyId, { title, body, url: "/dashboard", tag: "appels" });
  }).catch((err) => console.error("[appels d'offres] échec :", (err as Error).message));
  // veille concurrentielle : toutes les cinq minutes suffit, un changement de tête n'est pas à la seconde
  if (tickCount % 10 === 0) {
    await competitionMap()
      .then((map) =>
        watchCompetition(map, async (companyId, title, body) => {
          await sendToCompany(companyId, { title, body, url: "/dashboard", tag: "concurrence" });
        })
      )
      .catch((err) => console.error("[concurrence] échec :", (err as Error).message));
  }
  // décisions du directeur (1.6) : échéances, promesses, nouvelles situations
  if (tickCount % 10 === 0) {
    await runDecisions(async (companyId, title, body) => {
      await sendToCompany(companyId, { title, body, url: "/dashboard", tag: "decision" });
    }).catch((err) => console.error("[décisions] échec :", (err as Error).message));
  }
  // 1.7 : revenus des gares (toutes les heures), échéances d'emprunt, cours de bourse, dividendes, rapport hebdo
  if (tickCount % 120 === 0) await payStationIncome().catch((err) => console.error("[gares] échec :", (err as Error).message));
  await runLoanPayments(async (companyId, title, body) => {
    await sendToCompany(companyId, { title, body, url: "/dashboard", tag: "banque" });
  }).catch((err) => console.error("[emprunts] échec :", (err as Error).message));
  if (tickCount % 120 === 1) await runSharePrices().catch((err) => console.error("[bourse] échec :", (err as Error).message));
  // Premium : prix automatique (toutes les heures), ordres de bourse, alertes
  // 1.7 : et dès que l'heure change, pour suivre la pointe du matin et du soir
  const hourNow = parisHour();
  if (tickCount % 120 === 3 || hourNow !== lastPricingHour) {
    lastPricingHour = hourNow;
    await runAutoPricing().catch((err) => console.error("[prix auto] échec :", (err as Error).message));
  }
  // 2.0 : saisons (ouverture, clôture, rang de la veille) et points du tour
  if (tickCount % 10 === 1) {
    await runSeasons()
      .then(async (closed) => {
        if (closed) await notifySeasonEnd(closed.id).catch(() => {});
      })
      .catch((err) => console.error("[saisons] échec :", (err as Error).message));
  }
  await flushSeason().catch((err) => console.error("[saisons, points] échec :", (err as Error).message));
  await flushWorld()
    .then(async (opened) => {
      if (!opened) return;
      // le tunnel vient d'ouvrir : tout le monde est prévenu
      const ids = (await prisma.company.findMany({ select: { id: true } })) as { id: string }[];
      for (const c of ids) {
        await sendToCompany(c.id, { title: `${TUNNEL_NAME} est ouvert`, body: `${TUNNEL_STATIONS.join(" et ")} rejoignent la carte.`, url: "/dashboard", tag: "chantier" }).catch(() => {});
      }
    })
    .catch((err) => console.error("[grand chantier] échec :", (err as Error).message));
  if (tickCount % 120 === 4) await prisma.lineLoadHour.deleteMany({ where: { hour: { lt: new Date(Date.now() - 48 * 3600_000) } } }).catch(() => {});
  const premiumNotify = async (companyId: string, title: string, body: string, tag: string) => {
    await sendToCompany(companyId, { title, body, url: "/dashboard", tag });
  };
  await runStockOrders((id, t, b) => premiumNotify(id, t, b, "bourse")).catch((err) => console.error("[ordres de bourse] échec :", (err as Error).message));
  if (tickCount % 4 === 0) {
    await runPremiumAlerts((id, t, b) => premiumNotify(id, t, b, "alerte")).catch((err) => console.error("[alertes] échec :", (err as Error).message));
  }
  await runDividends().catch((err) => console.error("[dividendes] échec :", (err as Error).message));
  await runWeeklyReports(async (companyId, title, body) => {
    await sendToCompany(companyId, { title, body, url: "/dashboard", tag: "rapport" });
  }).catch((err) => console.error("[rapport hebdo] échec :", (err as Error).message));
  // bilan du matin : isolé, un raté ne doit pas interrompre le tick
  await runMorningDigest().catch((err) => console.error("[bilan] échec :", (err as Error).message));
  if (tickCount % MILESTONE_EVERY === 0) await processReferralMilestones();
}

const REFERRAL_REWARD = 150; // versé au parrain une fois que l'ami invité a vraiment commencé à jouer

async function processReferralRewards() {
  // un ami invité qui n'a pas encore rapporté sa récompense au parrain
  const pendingReferrals = await prisma.company.findMany({
    where: { referredById: { not: null }, referralRewardGranted: false },
    select: { id: true, referredById: true },
  });

  for (const referred of pendingReferrals) {
    if (!referred.referredById) continue;

    // condition minimale pour prouver que l'ami a vraiment commencé à jouer, pas juste créé un compte
    const [trainCount, lineCount] = await Promise.all([
      prisma.train.count({ where: { companyId: referred.id } }),
      prisma.line.count({ where: { companyId: referred.id } }),
    ]);

    if (trainCount >= 1 && lineCount >= 1) {
      await prisma.$transaction([
        prisma.company.update({ where: { id: referred.id }, data: { referralRewardGranted: true } }),
        prisma.company.update({
          where: { id: referred.referredById },
          data: { balance: { increment: REFERRAL_REWARD } },
        }),
        prisma.transaction.create({
          data: {
            companyId: referred.referredById,
            type: "PARRAINAGE",
            amount: REFERRAL_REWARD,
            description: "Récompense de parrainage : un ami invité a fondé son réseau",
          },
        }),
      ]);
    }
  }
}

const INCIDENT_CHANCE = 0.015;   // probabilité qu'un train en ligne subisse un retard ce tick
// Ce taux s'applique à chaque cycle de 30s pendant toute la durée du trajet : plus la ligne
// est longue, plus il y a de cycles, donc plus d'occasions de tirer un incident. Réglé pour
// qu'un trajet de 20-25 minutes ait en moyenne moins d'un incident, pas plusieurs.
const REVENUE_PER_MINUTE = 8;    // recette voyageurs par minute de trajet, versée à chaque arrivée

/* Rendement au kilomètre : un long-courrier rapporte plus à la minute qu'un
   omnibus — c'est vrai des vrais réseaux, et ça donne enfin un enjeu à la
   longueur d'une ligne. La contrepartie n'est pas un malus artificiel : une
   rame engagée sur 20 minutes est immobilisée d'autant, et une panne en cours
   de route lui fait perdre bien plus de trajet que sur une desserte courte.
   +0 % à 3 minutes, +25 % à 20 minutes et au-delà. */
export function lengthYield(durationMinutes: number) {
  const d = Math.max(3, Math.min(20, durationMinutes));
  return 1 + 0.25 * ((d - 3) / 17);
}
const DAMAGE_CHANCE = 0.3;       // pour une cargaison fragile, probabilité de dommage à la livraison
const DAMAGE_PAYOUT_RATIO = 0.2; // fraction de la récompense encaissée en cas de dommage
const DAMAGE_WEAR_PENALTY = 15;  // usure supplémentaire infligée au train en cas de dommage

/* 2.0 : les épisodes météo inventés (brouillard, canicule, verglas, neige sur
   tout le réseau d'un coup) ont laissé la place à la vraie météo des gares :
   voir realweather.service. */

/* Réputations clients de toutes les compagnies, en une requête : appeler la
   base pour chaque livraison serait absurde alors que le tick en traite des dizaines. */
async function getReputationByCompany(): Promise<Map<string, Map<string, number>>> {
  const rows = await prisma.clientRelation.findMany({
    select: { companyId: true, clientId: true, reputation: true },
  });
  const byCompany = new Map<string, Map<string, number>>();
  (rows as Array<{ companyId: string; clientId: string; reputation: number }>).forEach((r) => {
    let m = byCompany.get(r.companyId);
    if (!m) { m = new Map<string, number>(); byCompany.set(r.companyId, m); }
    m.set(r.clientId, r.reputation);
  });
  return byCompany;
}

async function getPremiumCompanyIds(): Promise<Set<string>> {
  const rows = await prisma.company.findMany({ where: { isPremium: true }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

export async function runLineTrains(weather: Map<string, StationWeather> = new Map()) {
  const runningTrains = await prisma.train.findMany({
    where: { status: "EN_ROUTE", lineId: { not: null } },
    include: { line: true },
  });
  const staffEffects = await staffEffectsByCompany();
  // 2.0 : contrôleurs et conducteurs affectés aux rames
  const crews = await crewByTrain().catch(() => new Map());
  const mountainBoost = mountainDemand();
  const weekend = isWeekend();
  // gares et concurrence : calculées une fois pour tout le tour
  /* 1.5 : les gares d'un temps fort de saison s'ajoutent aux événements du
     moment, et les correspondances de chaque compagnie sont comptées une fois. */
  const [liveEvents, competition, hubCounts, decisionEffects, owners, workshops] = await Promise.all([
    activeStationEvents(),
    competitionMap(),
    allStationCounts(),
    activeDecisionEffects(),
    stationOwners(),
    workshopsByCompany(),
  ]);
  // 1.7 : redevances et commerces dus aux propriétaires de gares, versés d'un bloc chaque heure
  const pending = new Map<string, { fees: number; shops: number }>();
  const owe = (station: string, key: "fees" | "shops", amount: number) => {
    const p = pending.get(station) ?? { fees: 0, shops: 0 };
    p[key] += amount;
    pending.set(station, p);
  };
  const stationEvents = [...liveEvents, ...seasonalStationEvents()];
  const night = isNightService();
  // 2.0 : alliances, pour la correspondance d'alliance et les redevances entre alliés
  const allianceOf = await allianceMap().catch(() => new Map<string, string>());
  const alliesCache = new Map<string, Set<string>>();
  const alliesFor = (companyId: string) => {
    let a = alliesCache.get(companyId);
    if (!a) alliesCache.set(companyId, (a = alliesOf(allianceOf, companyId)));
    return a;
  };
  // 1.7 : heures de pointe, la demande suit l'heure de la journée
  const rush = peakFactor();
  // 1.7 : rames de chaque ligne en circulation, qui se partagent ses voyageurs
  const runningOnLine = new Map<string, number>();
  for (const t of runningTrains) if (t.lineId) runningOnLine.set(t.lineId, (runningOnLine.get(t.lineId) ?? 0) + 1);

  for (const train of runningTrains) {
    const fx = staffEffects.get(train.companyId) ?? NO_STAFF;
    if (!train.line || !train.departedAt) continue;

    /* Incident aléatoire : le train perd un tick. La progression étant calculée
       depuis departedAt, il ne suffit pas de sauter le tour — il faut repousser
       l'heure de départ, sinon le « retard » n'a aucun effet sur l'arrivée.
       Par temps de verglas, ce risque est doublé. */
    const crew = crews.get(train.id);
    const driver = driverEffects(crew?.CONDUCTEUR);
    const dlcModel = DLC_MODELS[train.model];
    // 2.0 : la vraie météo, la pire rencontrée sur l'itinéraire de la ligne
    const wx = routeWeather(weather instanceof Map ? weather : new Map(), routeOf(train.line as typeof train.line & { stops?: string[] }));
    if (Math.random() < INCIDENT_CHANCE * wx.incident * driver.delay) {
      await prisma.$transaction([
        prisma.train.update({
          where: { id: train.id },
          data: { departedAt: new Date(new Date(train.departedAt).getTime() + TICK_INTERVAL_MS) },
        }),
        prisma.incident.create({
          data: {
            trainId: train.id,
            message: `Retard signalé : ${train.name} sur ${train.line.departureStation} → ${train.line.arrivalStation}${wx.effect && wx.at ? ` (${wx.label.toLowerCase()} à ${wx.at})` : ""}`,
          },
        }),
      ]);
      continue;
    }

    // Par brouillard, neige ou orage, un train peut être ralenti (pas d'avancée ce tick, sans pénalité d'usure)
    if (wx.slow > 0 && Math.random() < wx.slow) {
      continue;
    }

    // Usure du matériel : un mécanicien réduit le rythme d'usure (davantage encore en Premium),
    // une canicule l'accélère au contraire.
    /* L'usure ne descendait jamais sous 1 : Math.ceil(2 × 0,3) et Math.ceil(2 / 2)
       valent tous les deux 1, donc l'avantage Premium annoncé était nul depuis
       le début. On accumule désormais l'usure en dixièmes de point, ce qui rend
       les fractions réelles au lieu d'être avalées par l'arrondi. */
    // l'équipe de mécaniciens réduit l'usure des rames qu'elle couvre (voir staff.service)
    let wearRate = WEAR_PER_TICK * fx.wearMultiplier;
    wearRate = wearRate * wx.wear;
    const lineX = train.line as typeof train.line & { stops?: string[]; priceRatio?: number; electrified?: boolean };
    const trainX = train as typeof train & { cars?: string[]; direction?: number };
    // 1.7 : une ligne électrifiée use moins le matériel, un atelier sur l'itinéraire aussi
    if (lineX.electrified) wearRate = wearRate * ELECTRIC_WEAR;
    const shops = workshops.get(train.companyId);
    if (shops && routeOf(lineX).some((st) => shops.has(st))) wearRate = wearRate * WORKSHOP_WEAR;
    // 2.0 : le matériel d'extension, la pente sans crémaillère, le conducteur
    if (dlcModel) wearRate = wearRate * dlcModel.wear;
    const heritage = heritageOf(train as { heritage?: unknown });
    if (heritage) wearRate = wearRate * HERITAGE_WEAR;
    const mountainLine = routeOf(lineX).some((st) => MOUNTAIN_STATIONS.includes(st));
    if (mountainLine && train.model !== "CREMAILLERE") wearRate = wearRate * MOUNTAIN_WEAR;
    wearRate = wearRate * driver.wear;
    const newWear = Math.min(100, train.wear + stochasticRound(wearRate));
    /* 2.0 : une rame négligée peut casser avant 100 % */
    const neglected = newWear >= NEGLECT_FROM && newWear < 100 && Math.random() < NEGLECT_CHANCE * driver.incident;
    if (newWear >= 100 || neglected) {
      /* Réparation automatique : la pièce vient du magasin si elle y est,
         sinon elle est commandée et la rame attend sa livraison. Si la
         trésorerie ne suit pas, la rame reste en panne. */
      const handled = await tryAutoRepair(train, train.lineId);

      if (!handled) {
        // écriture conditionnelle : une rame révisée par le joueur pendant le tour n'est pas écrasée
        const hit = await prisma.train.updateMany({
          where: { id: train.id, status: "EN_ROUTE", workshopUntil: null },
          data: breakdownData(train),
        });
        if (hit.count === 0) continue;
        const part = PARTS[weakestOrgan(organBias(train))];
        await prisma.incident.create({
          data: {
            trainId: train.id,
            message: neglected
              ? `${train.name} a cassé faute d'entretien (${part.label.toLowerCase()}) : il faut ${part.need}`
              : `${train.name} est tombé en panne (${part.label.toLowerCase()}) : il faut ${part.need}`,
          },
        });
      }
      continue;
    }

    const elapsedMs = Date.now() - new Date(train.departedAt).getTime();
    const elapsedMinutes = elapsedMs / 60_000;
    // Une rame Express effectue le trajet 30% plus vite ; 1.7 : chaque voiture ajoutée ralentit,
    // l'électrification fait gagner 10 %
    const effectiveDuration =
      train.line.durationMinutes * (train.model === "EXPRESS" ? 0.7 : 1) * (dlcModel?.speed ?? 1) * speedFactor(trainX) * (lineX.electrified ? ELECTRIC_SPEED : 1);
    const progress = Math.min(100, Math.floor((elapsedMinutes / effectiveDuration) * 100));

    if (progress >= 100) {
      // Arrivé à destination : recette voyageurs versée (modulée par la réputation
      // et par le directeur commercial en Premium), puis le trajet repart aussitôt
      const reputation = await computeReputation(train.companyId);
      const reputationMultiplier = 0.5 + (reputation / 100) * 0.5; // de 0.5x (mauvaise réputation) à 1x (parfaite)
      const directeurBonus = fx.revenueMultiplier;
      /* 1.4 : la recette dépend aussi des deux gares (taille et événements du
         moment) et, sur une liaison partagée, de la part des voyageurs que la
         compagnie arrive à attirer face aux autres. */
      const dep = train.line.departureStation;
      const arr = train.line.arrivalStation;
      /* 1.7 : les gares de tout l'itinéraire comptent, et le sens de marche
         donne les deux bouts du trajet qui vient de se terminer */
      const route = routeOf(lineX);
      const [from, to] = ((r) => [r[0], r[r.length - 1]])(routeInDirection(lineX, trainX.direction ?? 0));
      /* 2.0 : la montagne se remplit l'hiver et l'été, la vapeur le week-end */
      const demand =
        routeDemand(route, stationEvents) *
        (route.some((st) => MOUNTAIN_STATIONS.includes(st)) ? mountainBoost : 1) *
        (weekend && dlcModel?.weekendDemand ? dlcModel.weekendDemand : 1);
      const contenders = competition.get(pairKey(dep, arr)) ?? [];
      const competitionMultiplier = contenders.find((c) => c.companyId === train.companyId)?.multiplier ?? 1;
      const boosted = routeHasBoost(route, stationEvents);
      const price = lineX.priceRatio ?? 1;
      const load = tripLoad(
        trainX,
        passengersPerDeparture(demand * (train.model === "COUCHETTES" ? 1 : rush), route.length - 2, competitionMultiplier, price),
        runningOnLine.get(train.lineId as string) ?? 1,
        price
      );
      // correspondances : une gare où la compagnie a plusieurs lignes rapporte plus
      const hub = hubMultiplier(hubCounts.get(train.companyId), dep, arr);
      // 2.0 : correspondance d'alliance, +3 % par allié qui dessert l'une des deux gares
      const allyMult = allyMultiplier(alliesFor(train.companyId), hubCounts, dep, arr);
      /* 1.6 — la rame couchettes : moins confortable qu'une voiture assise le
         jour, mais c'est elle que les voyageurs de nuit paient cher. */
      const couchettes = train.model === "COUCHETTES";
      const nightTrip = couchettes && night;
      const nightMultiplier = couchettes ? (night ? NIGHT_MULTIPLIER : DAY_COUCHETTES_MULTIPLIER) : 1;
      // 1.6 — une ligne qui passe la frontière rapporte plus, péage déduit à part
      const international = route.some(isInternational);
      const revenue = Math.round(
        train.line.durationMinutes *
          REVENUE_PER_MINUTE *
          lengthYield(train.line.durationMinutes) *
          reputationMultiplier *
          directeurBonus *
          // 1.7 : voyageurs réellement emportés × prix du billet (demande et concurrence y sont)
          load.revenueFactor *
          hub *
          allyMult *
          nightMultiplier *
          // 1.6 : grève, travaux, campagne touristique… décidés par le directeur
          decisionMultiplier(decisionEffects.get(train.companyId), dep, arr) *
          (international ? INTL_REVENUE_BONUS : 1) *
          // 2.0 : le billet du matériel d'extension, le contrôleur à bord
          (dlcModel?.fare ?? 1) *
          // 2.0 : le prestige d'une rame de collection
          (heritage?.prestige ?? 1) *
          controllerBonus(crew?.CONTROLEUR)
      );
      /* 1.7 : gares achetées. Chez soi, le trajet rapporte un peu plus ; chez
         les autres, il leur doit une redevance de quai ; partout où il y a des
         commerces, ses voyageurs y dépensent. */
      const infra = stationEffects(route, train.companyId, revenue, load.passengers, owners, alliesFor(train.companyId));
      const revenueHome = Math.round(revenue * infra.homeBonus);
      const platformFees = infra.fees.reduce((a, f) => a + f.amount, 0);
      for (const f of infra.fees) owe(f.station, "fees", f.amount);
      for (const sh of infra.shops) owe(sh.station, "shops", sh.amount);
      const toll = international ? Math.round(revenue * TOLL_RATE) : 0;
      const ops: any[] = [
        prisma.train.updateMany({
          where: { id: train.id, status: "EN_ROUTE", workshopUntil: null },
          // 1.7 : la rame repart dans l'autre sens
          data: { progress: 0, departedAt: new Date(), wear: newWear, direction: (trainX.direction ?? 0) === 0 ? 1 : 0, lastPassengers: load.passengers, lastSeats: load.seats },
        }),
        prisma.company.update({
          where: { id: train.companyId },
          data: { balance: { increment: revenueHome - toll - platformFees } },
        }),
        prisma.transaction.create({
          data: {
            companyId: train.companyId,
            type: "REVENU_LIGNE",
            amount: revenueHome,
            trainId: train.id,
            lineId: train.lineId,
            // le libellé finit toujours par « sur A → B » (et « · affluence ») : les
            // appels d'offres et les succès de saison le relisent. La nuit se lit au début.
            description: `${nightTrip ? "Trajet de nuit" : "Trajet voyageurs"} : ${train.name} sur ${from} → ${to}${boosted ? " · affluence" : ""}`,
          },
        }),
      ];
      if (toll > 0) {
        ops.push(prisma.transaction.create({
          data: {
            companyId: train.companyId,
            type: "PEAGE",
            amount: -toll,
            trainId: train.id,
            lineId: train.lineId,
            description: `Péage de sillon : ${train.line.departureStation} → ${train.line.arrivalStation}`,
          },
        }));
      }
      // 1.7 : remplissage heure par heure, pour la courbe des abonnés
      const hourStart = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
      ops.push(prisma.lineLoadHour.upsert({
        where: { lineId_hour: { lineId: train.lineId as string, hour: hourStart } },
        create: { lineId: train.lineId as string, companyId: train.companyId, hour: hourStart, trips: 1, passengers: load.passengers, seats: load.seats, left: load.left },
        update: { trips: { increment: 1 }, passengers: { increment: load.passengers }, seats: { increment: load.seats }, left: { increment: load.left } },
      }));
      if (platformFees > 0) {
        ops.push(prisma.transaction.create({
          data: {
            companyId: train.companyId,
            type: "REDEVANCE_QUAI",
            amount: -platformFees,
            trainId: train.id,
            lineId: train.lineId,
            description: `Redevance de quai : ${infra.fees.map((f) => f.station).join(", ")}`,
          },
        }));
      }
      await prisma.$transaction(ops);
      /* 2.0 : points de saison et objectifs de la semaine (écrits en fin de tour) */
      const fullish = load.seats > 0 && load.passengers >= load.seats * 0.8;
      addSeasonPoints(train.companyId, POINTS.TRIP + (fullish ? POINTS.TRIP_FULL : 0));
      seasonEvent(train.companyId, "TRIPS");
      contribute(train.companyId); // 2.0 : le Grand Chantier avance d'un trajet
      if (fullish) seasonEvent(train.companyId, "FULL_TRIPS");
      if (load.seats > 0 && load.passengers >= load.seats && PEAK_HOURS.includes(parisHour())) seasonEvent(train.companyId, "RUSH_FULL");
      if (international) seasonEvent(train.companyId, "INTL");
      if (nightTrip) seasonEvent(train.companyId, "NIGHT");
      await afterTrip(train, newWear, route, driver.incident).catch((err) => console.error("[atelier] fin de trajet :", (err as Error).message));
    } else if (progress !== train.progress || newWear !== train.wear) {
      await prisma.train.updateMany({
        where: { id: train.id, status: "EN_ROUTE", workshopUntil: null },
        data: { progress, wear: newWear },
      });
    }
  }
  await accruePending(pending).catch((err) => console.error("[gares] redevances non enregistrées :", (err as Error).message));
}

async function runFreightContracts(weather: Map<string, StationWeather> = new Map()) {
  const activeContracts = await prisma.contract.findMany({
    where: { status: "EN_COURS" },
    include: { train: true },
  });
  const premiumCompanyIds = await getPremiumCompanyIds();
  const staffEffects = await staffEffectsByCompany();
  const reputationByClient = await getReputationByCompany();
  const cargoIndex = await getCargoIndexMap();

  for (const contract of activeContracts) {
    if (!contract.train || !contract.acceptedAt) continue;
    // 2.0 : la vraie météo, au départ ou à l'arrivée de la cargaison
    const fwx = routeWeather(weather instanceof Map ? weather : new Map(), [contract.originStation, contract.destinationStation]);
    const incidentChance = INCIDENT_CHANCE * fwx.incident;

    /* Usure du fret. Elle manquait purement et simplement : une rame affectée
       au fret roulait indéfiniment sans jamais tomber en panne, alors que le
       fret paie mieux qu'une ligne voyageurs. Le choix entre les deux n'en
       était donc pas un. Mêmes règles que pour les lignes : le mécanicien
       divise l'usure par deux, la canicule la multiplie par 1,5, et on
       accumule en fractions pour que l'arrondi n'avale pas le bonus. */
    const ffx = staffEffects.get(contract.companyId as string) ?? NO_STAFF;
    let freightWearRate = WEAR_PER_TICK * ffx.wearMultiplier;
    freightWearRate = freightWearRate * fwx.wear;
    const wearNow = Math.min(100, contract.train.wear + stochasticRound(freightWearRate));

    // Même risque de retard aléatoire que sur les lignes voyageurs, renforcé par temps de verglas
    if (Math.random() < incidentChance) {
      await prisma.incident.create({
        data: {
          trainId: contract.train.id,
          message: `Retard signalé sur le fret : ${contract.train.name} (${contract.cargoType})`,
        },
      });
      /* Le retard doit vraiment retarder : la progression étant calculée depuis
         l'heure d'acceptation, décaler cette heure est le seul moyen de rendre
         l'incident réel. Sans cela, il ne coûtait rien — et faisait même sauter
         l'usure du tour, ce qui en faisait un bonus. */
      await prisma.contract.update({
        where: { id: contract.id },
        data: { acceptedAt: new Date(new Date(contract.acceptedAt).getTime() + TICK_INTERVAL_MS) },
      });
      await prisma.train.update({ where: { id: contract.train.id }, data: { wear: wearNow } });
      continue;
    }

    const elapsedMs = Date.now() - new Date(contract.acceptedAt).getTime();
    const elapsedMinutes = elapsedMs / 60_000;
    const progress = Math.min(100, Math.floor((elapsedMinutes / contract.durationMinutes) * 100));

    if (progress >= 100) {
      // Livraison terminée : pour une cargaison fragile, risque de dommage réduisant
      // fortement la récompense et abîmant le train ; sinon récompense pleine.
      // Une rame Fret Lourd rapporte 25% de récompense en plus, le directeur commercial 15% de plus (Premium).
      let baseReward = contract.train.model === "FRET_LOURD" ? Math.round(contract.reward * 1.25) : contract.reward;
      if (ffx.revenueMultiplier > 1) {
        baseReward = Math.round(baseReward * ffx.revenueMultiplier);
      }
      /* Fidélité client : la réputation gagnée en honorant des ordres majore
         le tarif de TOUTES les cargaisons de ce donneur d'ordre. C'est ce qui
         fait de la spécialisation une stratégie et non une collection de primes. */
      const loyalty = cargoBonus(
        contract.cargoType,
        reputationByClient.get(contract.companyId as string) ?? new Map<string, number>()
      );
      if (loyalty > 0) baseReward = Math.round(baseReward * (1 + loyalty));
      /* Cours du jour : livrer une marchandise recherchée paie mieux que la
         livrer quand personne n'en veut. C'est ce qui relie le tableau des
         cours aux trains, au lieu d'en faire un jeu séparé. */
      const index = cargoIndex.get(contract.cargoType);
      if (index !== undefined) baseReward = Math.round(baseReward * freightMultiplier(index));
      // Une compagnie Premium subit deux fois moins de risque de dommage sur les cargaisons fragiles
      let effectiveDamageChance = premiumCompanyIds.has(contract.companyId as string) ? DAMAGE_CHANCE / 2 : DAMAGE_CHANCE;
      if (contract.insured) effectiveDamageChance /= 2; // la prime d'assurance réduit encore le risque de moitié
      const damaged = contract.risky && Math.random() < effectiveDamageChance;
      const payout = damaged ? Math.round(baseReward * DAMAGE_PAYOUT_RATIO) : baseReward;
      const newWear = Math.min(100, damaged ? wearNow + DAMAGE_WEAR_PENALTY : wearNow);
      /* Une rame qui atteint l'usure maximale rentre en panne — mais seulement
         à l'arrivée. L'immobiliser en pleine livraison laisserait la cargaison
         dans les limbes et le contrat sans issue. */
      const arrivesBroken = newWear >= 100;

      const updates: Prisma.PrismaPromise<any>[] = [
        prisma.contract.update({
          where: { id: contract.id },
          data: { status: "LIVREE", trainId: null },
        }),
        prisma.train.update({
          where: { id: contract.train.id },
          data: {
            status: arrivesBroken ? "MAINTENANCE" : "IDLE",
            progress: 0,
            departedAt: null,
            wear: newWear,
            ...(arrivesBroken ? { brokenPart: weakestOrgan(organBias(contract.train)) } : {}),
          },
        }),
        prisma.company.update({
          where: { id: contract.companyId as string },
          data: { balance: { increment: payout } },
        }),
        prisma.transaction.create({
          data: {
            companyId: contract.companyId as string,
            type: "FRET",
            amount: payout,
            trainId: contract.train.id,
            description: damaged
              ? `Cargaison endommagée en route : ${contract.cargoType} (${contract.originStation} → ${contract.destinationStation})`
              : `Livraison "${contract.cargoType}" (${contract.originStation} → ${contract.destinationStation})`,
          },
        }),
      ];

      if (damaged) {
        updates.push(
          prisma.incident.create({
            data: {
              trainId: contract.train.id,
              message: `Cargaison fragile endommagée durant le transport : ${contract.cargoType}`,
            },
          })
        );
      }

      await prisma.$transaction(updates);
      // 2.0 : saison
      addSeasonPoints(contract.companyId as string, POINTS.FREIGHT);
      seasonEvent(contract.companyId as string, "FREIGHT");
      if (contract.risky && !damaged) seasonEvent(contract.companyId as string, "FRAGILE");

      /* Une cargaison endommagée ne compte pas pour un ordre : le client a
         commandé de la marchandise en bon état, pas des débris. */
      if (!damaged) {
        await creditDelivery(contract.companyId as string, contract.cargoType);
      }

      // même règle qu'en ligne : la rame qui rentre en panne est réparée si la trésorerie suit
      if (arrivesBroken) {
        const repaired = await tryAutoRepair({ ...contract.train, companyId: contract.companyId as string }, null);
        if (!repaired) {
          await prisma.incident.create({
            data: {
              trainId: contract.train.id,
              message: `${contract.train.name} est rentré en panne et nécessite une réparation`,
            },
          });
        }
      }
    } else {
      await prisma.train.update({
        where: { id: contract.train.id },
        data: { progress, wear: wearNow },
      });
    }
  }
}

/* Entretien du réseau, prélevé à chaque tick. La charge croît avec le carré du
   parc : c'est ce qui donne une taille optimale à une compagnie, au lieu d'une
   croissance indéfiniment rentable.

   Une compagnie à court de trésorerie n'est pas sanctionnée deux fois : on
   prélève ce qu'elle a, et l'entretien différé se paie en usure — les rames se
   dégradent plus vite tant que les comptes ne suivent pas. */
/* Tarif identique à la réparation manuelle : un chef de dépôt divise le coût
   par deux, sinon 2 pi. par point d'usure. */
/* Réparation automatique — désormais pour toutes les compagnies.

   Elle était réservée aux abonnés, et c'était un avantage de revenu déguisé :
   la flotte d'un abonné continuait de rouler la nuit pendant que celle d'un
   joueur gratuit s'arrêtait à la première panne. La facture est identique pour
   tout le monde, seul le clic disparaît — il n'y avait donc aucune raison de le
   faire payer.

   Elle garde une limite, qui est la vraie sanction : si la trésorerie ne suit
   pas, la rame reste en panne jusqu'à ce que le joueur intervienne.

   Et elle corrige au passage un défaut : la rame réparée repassait « à quai »,
   alors que la simulation ne fait rouler que les rames « en route ». Une rame
   de ligne réparée automatiquement s'arrêtait donc net. Elle repart désormais
   sur sa ligne, comme après une réparation manuelle. */
async function tryAutoRepair(
  train: { id: string; companyId: string; name: string; organs?: unknown; wear?: number },
  lineId: string | null,
  forcedPart?: Organ
): Promise<false | "repaired" | "ordered"> {
  const [company, fx] = await Promise.all([
    prisma.company.findUnique({ where: { id: train.companyId }, select: { balance: true, partsStock: true } }),
    staffEffectsFor(train.companyId),
  ]);
  if (!company) return false;

  /* 2.0 : la réparation demande la pièce de l'organe qui a lâché. Au
     magasin, la rame repart tout de suite ; sinon la pièce est commandée au
     tarif normal et la rame attend sa livraison, en panne. */
  const part = forcedPart ?? (weakestOrgan(organBias(train)) as Organ);
  const labor = Math.ceil(100 * repairCostPerPoint(fx));
  const inStock = (readStock(company.partsStock)[part] ?? 0) > 0;

  if (inStock && company.balance >= labor && (await takeFromStock(train.companyId, part))) {
    await prisma.$transaction([
      prisma.train.update({
        where: { id: train.id },
        data: {
          wear: 0,
          brokenPart: null,
          organs: freshBias() as unknown as Prisma.InputJsonValue,
          ...(lineId ? { status: "EN_ROUTE", progress: 0, departedAt: new Date() } : { status: "IDLE", progress: 0, departedAt: null }),
        },
      }),
      prisma.company.update({ where: { id: train.companyId }, data: { balance: { decrement: labor } } }),
      prisma.transaction.create({
        data: { companyId: train.companyId, type: "REPARATION", amount: -labor, description: `Réparation automatique de ${train.name}, pièce du magasin (${PARTS[part].part.toLowerCase()})`, trainId: train.id, lineId },
      }),
    ]);
    return "repaired";
  }

  const cost = labor + partPrice(part, "order");
  if (company.balance < cost) return false;
  const eta = new Date(Date.now() + partDelayMs(part, "order"));
  const hhmm = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(eta);
  await prisma.$transaction([
    prisma.train.update({ where: { id: train.id }, data: { ...breakdownData(train, part), partsEta: eta } }),
    prisma.company.update({ where: { id: train.companyId }, data: { balance: { decrement: cost } } }),
    prisma.transaction.create({
      data: { companyId: train.companyId, type: "REPARATION", amount: -cost, description: `Réparation automatique de ${train.name} : pièce commandée (${PARTS[part].part.toLowerCase()}), livrée à ${hhmm}`, trainId: train.id, lineId },
    }),
    prisma.incident.create({ data: { trainId: train.id, message: `${train.name} est en panne (${PARTS[part].label.toLowerCase()}) : pièce commandée, livrée à ${hhmm}` } }),
  ]);
  return "ordered";
}

/* 2.0 : en fin de trajet, un incident sur la voie peut survenir, et une rame
   dont la révision est programmée part à l'atelier si elle a atteint son seuil. */
async function afterTrip(
  train: { id: string; name: string; companyId: string; lineId: string | null; organs?: unknown; serviceAt?: number | null },
  wear: number,
  route: string[],
  incidentFactor: number
) {
  if (Math.random() < TRACK_INCIDENT_CHANCE * incidentFactor) {
    const inc = TRACK_INCIDENTS[Math.floor(Math.random() * TRACK_INCIDENTS.length)];
    const place = route[Math.floor(Math.random() * route.length)];
    const bias = organBias(train);
    bias[inc.organ] = Math.min(2, bias[inc.organ] + 0.35);
    const hit = Math.min(100, wear + inc.wear);
    const breaks = hit >= 100 || Math.random() < inc.breakChance;
    await prisma.train.update({
      where: { id: train.id },
      data: breaks ? { ...breakdownData({ id: train.id, organs: bias }, inc.organ) } : { wear: hit, organs: bias as unknown as Prisma.InputJsonValue },
    });
    await prisma.incident.create({ data: { trainId: train.id, message: `${inc.text(train.name, place)}${breaks ? ` : ${PARTS[inc.organ].label.toLowerCase()} hors service` : ""}` } });
    void sendToCompany(train.companyId, {
      title: breaks ? `${train.name} immobilisée` : `Incident sur la voie`,
      body: `${inc.text(train.name, place)}.${breaks ? ` Il faut ${PARTS[inc.organ].need}.` : ""}`,
      url: "/dashboard",
      tag: "incident",
    });
    if (breaks) {
      const handled = await tryAutoRepair({ ...train, organs: bias }, train.lineId, inc.organ);
      if (!handled) return;
    }
    return;
  }

  // révision programmée : en fin de trajet, au-delà du seuil
  if (!train.serviceAt || wear < train.serviceAt) return;
  const company = await prisma.company.findUnique({ where: { id: train.companyId }, select: { balance: true } });
  const fx = await staffEffectsFor(train.companyId);
  const cost = Math.ceil(wear * repairCostPerPoint(fx) * SERVICE_DISCOUNT);
  if (!company || company.balance < cost) return;
  const until = new Date(Date.now() + serviceMinutes(wear) * 60_000);
  await prisma.$transaction([
    prisma.train.update({
      where: { id: train.id },
      data: { wear: 0, status: "MAINTENANCE", workshopUntil: until, progress: 0, departedAt: null, organs: freshBias() as unknown as Prisma.InputJsonValue },
    }),
    prisma.company.update({ where: { id: train.companyId }, data: { balance: { decrement: cost } } }),
    prisma.transaction.create({ data: { companyId: train.companyId, type: "REPARATION", amount: -cost, description: `Révision programmée de ${train.name}`, trainId: train.id, lineId: train.lineId } }),
  ]);
  seasonEvent(train.companyId, "REVISE");
}

async function runUpkeep() {
  const companies = await prisma.company.findMany({
    select: { id: true, balance: true, _count: { select: { trains: true } } },
  });

  for (const c of companies as Array<{ id: string; balance: number; _count: { trains: number } }>) {
    const due = upkeepPerTick(c._count.trains);
    if (due <= 0) continue;

    const paid = Math.min(due, c.balance);

    if (paid > 0) {
      await prisma.$transaction([
        prisma.company.update({ where: { id: c.id }, data: { balance: { decrement: paid } } }),
        prisma.transaction.create({
          data: {
            companyId: c.id,
            type: "ENTRETIEN",
            amount: -paid,
            description: `Entretien du réseau (${c._count.trains} rames)`,
          },
        }),
      ]);
    }

    // entretien impayé : les rames en service se dégradent plus vite
    if (paid < due) {
      await prisma.train.updateMany({
        where: { companyId: c.id, status: "EN_ROUTE" },
        data: { wear: { increment: 1 } },
      });
    }
  }
}

/* Chômage technique : un mécanicien ou un chef de dépôt n'est payé que si la
   compagnie a au moins une rame en service. Sans cela, une flotte de fret à
   quai toute la nuit — elle attend qu'on lui confie un contrat — payait une
   équipe qui n'avait rien à entretenir, et le joueur avait l'impression de
   devoir rester connecté pour ne pas perdre d'argent. Le directeur commercial
   reste payé : son travail ne dépend pas des rames qui roulent. */
const ROLES_IDLE_WITH_FLEET = new Set(["MECANICIEN", "CHEF_DEPOT"]);

const STAFF_PATIENCE_TICKS = 120; // une heure de tours de 30 s
const warnedCompanies = new Set<string>();

export async function runPayroll() {
  const [staffMembers, running] = await Promise.all([
    prisma.staff.findMany(),
    prisma.train.groupBy({ by: ["companyId"], where: { status: "EN_ROUTE" }, _count: { _all: true } }),
  ]);
  const hasRunning = new Set(
    (running as { companyId: string; _count: { _all: number } }[]).filter((r) => r._count._all > 0).map((r) => r.companyId)
  );

  for (const staff of staffMembers) {
    if (ROLES_IDLE_WITH_FLEET.has(staff.role) && !hasRunning.has(staff.companyId)) continue;

    const company = await prisma.company.findUnique({ where: { id: staff.companyId } });
    if (!company) continue;

    const unpaid = staff.unpaidTicks ?? 0;
    if (company.balance < staff.salaryPerTick) {
      /* 1.7.2 : un salaire manqué ne fait plus partir l'employé sur-le-champ.
         Avant, un seul tour à trésorerie vide (un achat, l'entretien du
         réseau) vidait toute l'équipe d'un coup. Il patiente désormais une
         heure ; le joueur est prévenu au premier salaire manqué. */
      const next = unpaid + 1;
      if (next < STAFF_PATIENCE_TICKS) {
        await prisma.staff.update({ where: { id: staff.id }, data: { unpaidTicks: next } });
        if (next === 1) {
          await prisma.transaction.create({
            data: {
              companyId: staff.companyId,
              type: "PERSONNEL",
              amount: 0,
              description: `${staff.name || "Un employé"} n'a pas été payé : sans trésorerie d'ici une heure, il quittera la compagnie`,
            },
          });
          if (!warnedCompanies.has(staff.companyId)) {
            warnedCompanies.add(staff.companyId);
            void sendToCompany(staff.companyId, {
              title: "Salaires impayés",
              body: "Votre trésorerie ne couvre plus les salaires. Sans rentrée d'argent d'ici une heure, votre personnel partira.",
              url: "/dashboard",
              tag: "personnel",
            });
          }
        }
        continue;
      }
      // une heure sans salaire : l'employé quitte la compagnie
      await prisma.$transaction([
        prisma.staff.delete({ where: { id: staff.id } }),
        prisma.transaction.create({
          data: {
            companyId: staff.companyId,
            type: "PERSONNEL",
            amount: 0,
            description: `${staff.name || "Un employé"} a quitté la compagnie après une heure sans salaire`,
          },
        }),
      ]);
      continue;
    }

    await prisma.company.update({
      where: { id: staff.companyId },
      data: { balance: { decrement: staff.salaryPerTick } },
    });
    if (unpaid > 0) {
      await prisma.staff.update({ where: { id: staff.id }, data: { unpaidTicks: 0 } });
      warnedCompanies.delete(staff.companyId);
    }
  }
}
