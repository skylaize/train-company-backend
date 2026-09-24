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
import { activeStationEvents, competitionMap, lineDemand, lineHasBoost, maybeSpawnStationEvent, pairKey, watchCompetition } from "../services/station.service";
import { sendToCompany } from "../services/push.service";
import { checkPriceAlerts, runStandingOrders } from "../controllers/market.controller";
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
  setInterval(() => {
    runSimulationTick().catch((err) => {
      console.error("[simulation] tour ignoré après erreur :", err);
    });
  }, TICK_INTERVAL_MS);
  console.log("Simulation du réseau démarrée (tick toutes les 30s)");
}

// les paliers de parrainage bougent lentement : inutile de les recalculer
// toutes les 30 secondes, un passage toutes les 5 minutes suffit
let tickCount = 0;
const MILESTONE_EVERY = 10;

async function runSimulationTick() {
  tickCount += 1;
  await maybeChangeWeather();
  // gares : un événement naît de temps en temps, annoncé une heure à l'avance
  await maybeSpawnStationEvent().catch((err) => console.error("[gares] échec :", (err as Error).message));
  const weather = await getActiveWeather();
  await runLineTrains(weather);
  await runFreightContracts(weather);
  await runPayroll();
  await runStaffExperience();
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
const FOG_SLOWDOWN_CHANCE = 0.3; // par temps de brouillard, chance qu'un train soit ralenti ce tick
const DAMAGE_CHANCE = 0.3;       // pour une cargaison fragile, probabilité de dommage à la livraison
const DAMAGE_PAYOUT_RATIO = 0.2; // fraction de la récompense encaissée en cas de dommage
const DAMAGE_WEAR_PENALTY = 15;  // usure supplémentaire infligée au train en cas de dommage

async function getActiveWeather(): Promise<string> {
  const active = await prisma.weatherEvent.findFirst({
    where: { endsAt: { gt: new Date() } },
    orderBy: { startedAt: "desc" },
  });
  return active?.type ?? "CLAIR";
}

/* La météo suit la saison, à l'heure de Paris : la neige seulement de décembre
   à février, le verglas de novembre à mars, la canicule de mai à septembre.
   Le brouillard peut tomber toute l'année. Une entrée apparaît plusieurs fois
   quand elle doit être plus fréquente. */
export function seasonalWeatherTypes(now = new Date()): string[] {
  const month = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", month: "numeric" }).format(now));
  const types = ["BROUILLARD"];
  if (month === 12 || month <= 2) types.push("NEIGE", "NEIGE");
  if (month >= 11 || month <= 3) types.push("VERGLAS");
  if (month >= 5 && month <= 9) types.push("CANICULE", ...(month >= 6 && month <= 8 ? ["CANICULE"] : []));
  return types;
}

async function maybeChangeWeather() {
  const active = await prisma.weatherEvent.findFirst({ where: { endsAt: { gt: new Date() } } });
  if (active) return;

  // ~15% de chance par tick de déclencher un nouvel épisode météo (dure 3 à 6 minutes)
  if (Math.random() < 0.15) {
    const types = seasonalWeatherTypes();
    const type = types[Math.floor(Math.random() * types.length)];
    const durationMinutes = 3 + Math.floor(Math.random() * 4);
    await prisma.weatherEvent.create({
      data: { type, endsAt: new Date(Date.now() + durationMinutes * 60_000) },
    });
  }
}

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

async function runLineTrains(weather: string) {
  const runningTrains = await prisma.train.findMany({
    where: { status: "EN_ROUTE", lineId: { not: null } },
    include: { line: true },
  });
  const staffEffects = await staffEffectsByCompany();
  const incidentChance = weather === "VERGLAS" ? INCIDENT_CHANCE * 2 : weather === "NEIGE" ? INCIDENT_CHANCE * 1.5 : INCIDENT_CHANCE;
  // gares et concurrence : calculées une fois pour tout le tour
  const [stationEvents, competition] = await Promise.all([activeStationEvents(), competitionMap()]);

  for (const train of runningTrains) {
    const fx = staffEffects.get(train.companyId) ?? NO_STAFF;
    if (!train.line || !train.departedAt) continue;

    /* Incident aléatoire : le train perd un tick. La progression étant calculée
       depuis departedAt, il ne suffit pas de sauter le tour — il faut repousser
       l'heure de départ, sinon le « retard » n'a aucun effet sur l'arrivée.
       Par temps de verglas, ce risque est doublé. */
    if (Math.random() < incidentChance) {
      await prisma.$transaction([
        prisma.train.update({
          where: { id: train.id },
          data: { departedAt: new Date(new Date(train.departedAt).getTime() + TICK_INTERVAL_MS) },
        }),
        prisma.incident.create({
          data: {
            trainId: train.id,
            message: `Retard signalé : ${train.name} sur ${train.line.departureStation} → ${train.line.arrivalStation}`,
          },
        }),
      ]);
      continue;
    }

    // Par temps de brouillard ou de neige, un train peut être ralenti (pas d'avancée ce tick, sans pénalité d'usure)
    if ((weather === "BROUILLARD" || weather === "NEIGE") && Math.random() < FOG_SLOWDOWN_CHANCE) {
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
    if (weather === "CANICULE") wearRate = wearRate * 1.5;
    const newWear = Math.min(100, train.wear + stochasticRound(wearRate));
    if (newWear >= 100) {
      /* Réparation automatique en Premium : c'est du confort, pas un avantage
         économique — la facture est identique, seul l'aller-retour manuel
         disparaît. Si la trésorerie ne suit pas, la rame reste en panne. */
      const repaired = await tryAutoRepair(train.id, train.companyId, train.name, train.lineId);

      if (!repaired) {
        await prisma.train.update({
          where: { id: train.id },
          data: { wear: 100, status: "MAINTENANCE" },
        });
        await prisma.incident.create({
          data: {
            trainId: train.id,
            message: `${train.name} est tombé en panne et nécessite une réparation`,
          },
        });
      }
      continue;
    }

    const elapsedMs = Date.now() - new Date(train.departedAt).getTime();
    const elapsedMinutes = elapsedMs / 60_000;
    // Une rame Express effectue le trajet 30% plus vite (Premium)
    const effectiveDuration = train.model === "EXPRESS" ? train.line.durationMinutes * 0.7 : train.line.durationMinutes;
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
      const demand = lineDemand(dep, arr, stationEvents);
      const contenders = competition.get(pairKey(dep, arr)) ?? [];
      const competitionMultiplier = contenders.find((c) => c.companyId === train.companyId)?.multiplier ?? 1;
      const boosted = lineHasBoost(dep, arr, stationEvents);
      const revenue = Math.round(
        train.line.durationMinutes *
          REVENUE_PER_MINUTE *
          lengthYield(train.line.durationMinutes) *
          reputationMultiplier *
          directeurBonus *
          demand *
          competitionMultiplier
      );
      await prisma.$transaction([
        prisma.train.update({
          where: { id: train.id },
          data: { progress: 0, departedAt: new Date(), wear: newWear },
        }),
        prisma.company.update({
          where: { id: train.companyId },
          data: { balance: { increment: revenue } },
        }),
        prisma.transaction.create({
          data: {
            companyId: train.companyId,
            type: "REVENU_LIGNE",
            amount: revenue,
            trainId: train.id,
            lineId: train.lineId,
            description: `Trajet voyageurs : ${train.name} sur ${train.line.departureStation} → ${train.line.arrivalStation}${boosted ? " · affluence" : ""}`,
          },
        }),
      ]);
    } else if (progress !== train.progress || newWear !== train.wear) {
      await prisma.train.update({
        where: { id: train.id },
        data: { progress, wear: newWear },
      });
    }
  }
}

async function runFreightContracts(weather: string) {
  const activeContracts = await prisma.contract.findMany({
    where: { status: "EN_COURS" },
    include: { train: true },
  });
  const premiumCompanyIds = await getPremiumCompanyIds();
  const staffEffects = await staffEffectsByCompany();
  const reputationByClient = await getReputationByCompany();
  const cargoIndex = await getCargoIndexMap();
  const incidentChance = weather === "VERGLAS" ? INCIDENT_CHANCE * 2 : weather === "NEIGE" ? INCIDENT_CHANCE * 1.5 : INCIDENT_CHANCE;

  for (const contract of activeContracts) {
    if (!contract.train || !contract.acceptedAt) continue;

    /* Usure du fret. Elle manquait purement et simplement : une rame affectée
       au fret roulait indéfiniment sans jamais tomber en panne, alors que le
       fret paie mieux qu'une ligne voyageurs. Le choix entre les deux n'en
       était donc pas un. Mêmes règles que pour les lignes : le mécanicien
       divise l'usure par deux, la canicule la multiplie par 1,5, et on
       accumule en fractions pour que l'arrondi n'avale pas le bonus. */
    const ffx = staffEffects.get(contract.companyId as string) ?? NO_STAFF;
    let freightWearRate = WEAR_PER_TICK * ffx.wearMultiplier;
    if (weather === "CANICULE") freightWearRate = freightWearRate * 1.5;
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

      /* Une cargaison endommagée ne compte pas pour un ordre : le client a
         commandé de la marchandise en bon état, pas des débris. */
      if (!damaged) {
        await creditDelivery(contract.companyId as string, contract.cargoType);
      }

      // même règle qu'en ligne : la rame qui rentre en panne est réparée si la trésorerie suit
      if (arrivesBroken) {
        const repaired = await tryAutoRepair(contract.train.id, contract.companyId as string, contract.train.name, null);
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
async function tryAutoRepair(trainId: string, companyId: string, trainName: string, lineId: string | null) {
  const [company, fx] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { balance: true } }),
    staffEffectsFor(companyId),
  ]);
  if (!company) return false;

  const cost = Math.ceil(100 * repairCostPerPoint(fx));
  if (company.balance < cost) return false;

  await prisma.$transaction([
    prisma.train.update({
      where: { id: trainId },
      data: lineId
        ? { wear: 0, status: "EN_ROUTE", progress: 0, departedAt: new Date() }
        : { wear: 0, status: "IDLE", progress: 0, departedAt: null },
    }),
    prisma.company.update({ where: { id: companyId }, data: { balance: { decrement: cost } } }),
    prisma.transaction.create({
      data: {
        companyId,
        type: "REPARATION",
        amount: -cost,
        description: `Réparation automatique de ${trainName}`,
        trainId,
        lineId,
      },
    }),
  ]);
  return true;
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

async function runPayroll() {
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

    if (company.balance < staff.salaryPerTick) {
      // trésorerie insuffisante : l'employé quitte la compagnie
      await prisma.$transaction([
        prisma.staff.delete({ where: { id: staff.id } }),
        prisma.transaction.create({
          data: {
            companyId: staff.companyId,
            type: "PERSONNEL",
            amount: 0,
            description: `${staff.name || "Un employé"} a quitté la compagnie faute de trésorerie suffisante`,
          },
        }),
      ]);
      continue;
    }

    await prisma.company.update({
      where: { id: staff.companyId },
      data: { balance: { decrement: staff.salaryPerTick } },
    });
  }
}
