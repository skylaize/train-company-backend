"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSimulationJob = startSimulationJob;
exports.lengthYield = lengthYield;
const prisma_1 = require("../prisma");
const contract_controller_1 = require("../controllers/contract.controller");
const referral_milestone_service_1 = require("../services/referral-milestone.service");
const mission_service_1 = require("../services/mission.service");
const client_service_1 = require("../services/client.service");
const upkeep_service_1 = require("../services/upkeep.service");
const reputation_service_1 = require("../services/reputation.service");
const market_service_1 = require("../services/market.service");
const construction_service_1 = require("../services/construction.service");
const market_controller_1 = require("../controllers/market.controller");
// Tourne toutes les 30 secondes. Deux types de trajets sont gérés :
// - Ligne voyageurs : service continu, le train repart aussitôt arrivé.
// - Contrat de fret : trajet unique, le train est libéré et la récompense
//   versée à la compagnie une fois la livraison terminée.
// Le marché de contrats est aussi réapprovisionné à chaque tick.
const TICK_INTERVAL_MS = 30000;
function startSimulationJob() {
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
    const weather = await getActiveWeather();
    await runLineTrains(weather);
    await runFreightContracts(weather);
    await runPayroll();
    await runUpkeep();
    // avant de réapprovisionner : les ordres périmés libèrent leur marchandise
    await (0, mission_service_1.expireMissions)();
    await (0, contract_controller_1.removeExpiredContracts)();
    await (0, contract_controller_1.ensureMarketStocked)();
    await processReferralRewards();
    /* Cours du fret : le marché bouge que le joueur soit là ou non, sinon
       spéculer reviendrait à jouer contre une horloge qu'on met en pause soi-même. */
    await (0, market_service_1.runMarketTick)();
    await (0, market_service_1.runStorageFees)();
    await (0, market_controller_1.checkPriceAlerts)();
    await (0, market_controller_1.runStandingOrders)();
    // chantiers arrivés à terme : dépôt agrandi, entrepôt livré
    await (0, construction_service_1.completeConstructions)();
    if (tickCount % MILESTONE_EVERY === 0)
        await (0, referral_milestone_service_1.processReferralMilestones)();
}
const REFERRAL_REWARD = 150; // versé au parrain une fois que l'ami invité a vraiment commencé à jouer
async function processReferralRewards() {
    // un ami invité qui n'a pas encore rapporté sa récompense au parrain
    const pendingReferrals = await prisma_1.prisma.company.findMany({
        where: { referredById: { not: null }, referralRewardGranted: false },
        select: { id: true, referredById: true },
    });
    for (const referred of pendingReferrals) {
        if (!referred.referredById)
            continue;
        // condition minimale pour prouver que l'ami a vraiment commencé à jouer, pas juste créé un compte
        const [trainCount, lineCount] = await Promise.all([
            prisma_1.prisma.train.count({ where: { companyId: referred.id } }),
            prisma_1.prisma.line.count({ where: { companyId: referred.id } }),
        ]);
        if (trainCount >= 1 && lineCount >= 1) {
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.company.update({ where: { id: referred.id }, data: { referralRewardGranted: true } }),
                prisma_1.prisma.company.update({
                    where: { id: referred.referredById },
                    data: { balance: { increment: REFERRAL_REWARD } },
                }),
                prisma_1.prisma.transaction.create({
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
const WEAR_PER_TICK = 2; // usure gagnée à chaque tick pour un train en service sur une ligne
const INCIDENT_CHANCE = 0.015; // probabilité qu'un train en ligne subisse un retard ce tick
// Ce taux s'applique à chaque cycle de 30s pendant toute la durée du trajet : plus la ligne
// est longue, plus il y a de cycles, donc plus d'occasions de tirer un incident. Réglé pour
// qu'un trajet de 20-25 minutes ait en moyenne moins d'un incident, pas plusieurs.
const REVENUE_PER_MINUTE = 8; // recette voyageurs par minute de trajet, versée à chaque arrivée
/* Rendement au kilomètre : un long-courrier rapporte plus à la minute qu'un
   omnibus — c'est vrai des vrais réseaux, et ça donne enfin un enjeu à la
   longueur d'une ligne. La contrepartie n'est pas un malus artificiel : une
   rame engagée sur 20 minutes est immobilisée d'autant, et une panne en cours
   de route lui fait perdre bien plus de trajet que sur une desserte courte.
   +0 % à 3 minutes, +25 % à 20 minutes et au-delà. */
function lengthYield(durationMinutes) {
    const d = Math.max(3, Math.min(20, durationMinutes));
    return 1 + 0.25 * ((d - 3) / 17);
}
const FOG_SLOWDOWN_CHANCE = 0.3; // par temps de brouillard, chance qu'un train soit ralenti ce tick
const DAMAGE_CHANCE = 0.3; // pour une cargaison fragile, probabilité de dommage à la livraison
const DAMAGE_PAYOUT_RATIO = 0.2; // fraction de la récompense encaissée en cas de dommage
const DAMAGE_WEAR_PENALTY = 15; // usure supplémentaire infligée au train en cas de dommage
async function getActiveWeather() {
    const active = await prisma_1.prisma.weatherEvent.findFirst({
        where: { endsAt: { gt: new Date() } },
        orderBy: { startedAt: "desc" },
    });
    return active?.type ?? "CLAIR";
}
async function maybeChangeWeather() {
    const active = await prisma_1.prisma.weatherEvent.findFirst({ where: { endsAt: { gt: new Date() } } });
    if (active)
        return;
    // ~15% de chance par tick de déclencher un nouvel épisode météo (dure 3 à 6 minutes)
    if (Math.random() < 0.15) {
        const types = ["BROUILLARD", "CANICULE", "VERGLAS"];
        const type = types[Math.floor(Math.random() * types.length)];
        const durationMinutes = 3 + Math.floor(Math.random() * 4);
        await prisma_1.prisma.weatherEvent.create({
            data: { type, endsAt: new Date(Date.now() + durationMinutes * 60000) },
        });
    }
}
async function getCompaniesWithMecanicien() {
    const rows = await prisma_1.prisma.staff.findMany({ where: { role: "MECANICIEN" }, select: { companyId: true } });
    return new Set(rows.map((r) => r.companyId));
}
async function getCompaniesWithDirecteurCommercial() {
    const rows = await prisma_1.prisma.staff.findMany({ where: { role: "DIRECTEUR_COMMERCIAL" }, select: { companyId: true } });
    return new Set(rows.map((r) => r.companyId));
}
/* Réputations clients de toutes les compagnies, en une requête : appeler la
   base pour chaque livraison serait absurde alors que le tick en traite des dizaines. */
async function getReputationByCompany() {
    const rows = await prisma_1.prisma.clientRelation.findMany({
        select: { companyId: true, clientId: true, reputation: true },
    });
    const byCompany = new Map();
    rows.forEach((r) => {
        let m = byCompany.get(r.companyId);
        if (!m) {
            m = new Map();
            byCompany.set(r.companyId, m);
        }
        m.set(r.clientId, r.reputation);
    });
    return byCompany;
}
async function getPremiumCompanyIds() {
    const rows = await prisma_1.prisma.company.findMany({ where: { isPremium: true }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
}
async function runLineTrains(weather) {
    const runningTrains = await prisma_1.prisma.train.findMany({
        where: { status: "EN_ROUTE", lineId: { not: null } },
        include: { line: true },
    });
    const companiesWithMecanicien = await getCompaniesWithMecanicien();
    const companiesWithDirecteur = await getCompaniesWithDirecteurCommercial();
    const premiumCompanyIds = await getPremiumCompanyIds();
    const incidentChance = weather === "VERGLAS" ? INCIDENT_CHANCE * 2 : INCIDENT_CHANCE;
    for (const train of runningTrains) {
        if (!train.line || !train.departedAt)
            continue;
        /* Incident aléatoire : le train perd un tick. La progression étant calculée
           depuis departedAt, il ne suffit pas de sauter le tour — il faut repousser
           l'heure de départ, sinon le « retard » n'a aucun effet sur l'arrivée.
           Par temps de verglas, ce risque est doublé. */
        if (Math.random() < incidentChance) {
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.train.update({
                    where: { id: train.id },
                    data: { departedAt: new Date(new Date(train.departedAt).getTime() + TICK_INTERVAL_MS) },
                }),
                prisma_1.prisma.incident.create({
                    data: {
                        trainId: train.id,
                        message: `Retard signalé : ${train.name} sur ${train.line.departureStation} → ${train.line.arrivalStation}`,
                    },
                }),
            ]);
            continue;
        }
        // Par temps de brouillard, un train peut être ralenti (pas d'avancée ce tick, sans pénalité d'usure)
        if (weather === "BROUILLARD" && Math.random() < FOG_SLOWDOWN_CHANCE) {
            continue;
        }
        // Usure du matériel : un mécanicien réduit le rythme d'usure (davantage encore en Premium),
        // une canicule l'accélère au contraire.
        /* L'usure ne descendait jamais sous 1 : Math.ceil(2 × 0,3) et Math.ceil(2 / 2)
           valent tous les deux 1, donc l'avantage Premium annoncé était nul depuis
           le début. On accumule désormais l'usure en dixièmes de point, ce qui rend
           les fractions réelles au lieu d'être avalées par l'arrondi. */
        let wearRate = WEAR_PER_TICK;
        if (companiesWithMecanicien.has(train.companyId)) {
            wearRate = WEAR_PER_TICK / 2;
        }
        if (weather === "CANICULE")
            wearRate = wearRate * 1.5;
        const newWear = Math.min(100, Math.round(train.wear + wearRate));
        if (newWear >= 100) {
            /* Réparation automatique en Premium : c'est du confort, pas un avantage
               économique — la facture est identique, seul l'aller-retour manuel
               disparaît. Si la trésorerie ne suit pas, la rame reste en panne. */
            const repaired = premiumCompanyIds.has(train.companyId)
                ? await tryAutoRepair(train.id, train.companyId, train.name)
                : false;
            if (!repaired) {
                await prisma_1.prisma.train.update({
                    where: { id: train.id },
                    data: { wear: 100, status: "MAINTENANCE" },
                });
                await prisma_1.prisma.incident.create({
                    data: {
                        trainId: train.id,
                        message: `${train.name} est tombé en panne et nécessite une réparation`,
                    },
                });
            }
            continue;
        }
        const elapsedMs = Date.now() - new Date(train.departedAt).getTime();
        const elapsedMinutes = elapsedMs / 60000;
        // Une rame Express effectue le trajet 30% plus vite (Premium)
        const effectiveDuration = train.model === "EXPRESS" ? train.line.durationMinutes * 0.7 : train.line.durationMinutes;
        const progress = Math.min(100, Math.floor((elapsedMinutes / effectiveDuration) * 100));
        if (progress >= 100) {
            // Arrivé à destination : recette voyageurs versée (modulée par la réputation
            // et par le directeur commercial en Premium), puis le trajet repart aussitôt
            const reputation = await (0, reputation_service_1.computeReputation)(train.companyId);
            const reputationMultiplier = 0.5 + (reputation / 100) * 0.5; // de 0.5x (mauvaise réputation) à 1x (parfaite)
            const directeurBonus = companiesWithDirecteur.has(train.companyId) ? 1.15 : 1;
            const revenue = Math.round(train.line.durationMinutes *
                REVENUE_PER_MINUTE *
                lengthYield(train.line.durationMinutes) *
                reputationMultiplier *
                directeurBonus);
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.train.update({
                    where: { id: train.id },
                    data: { progress: 0, departedAt: new Date(), wear: newWear },
                }),
                prisma_1.prisma.company.update({
                    where: { id: train.companyId },
                    data: { balance: { increment: revenue } },
                }),
                prisma_1.prisma.transaction.create({
                    data: {
                        companyId: train.companyId,
                        type: "REVENU_LIGNE",
                        amount: revenue,
                        description: `Trajet voyageurs : ${train.name} sur ${train.line.departureStation} → ${train.line.arrivalStation}`,
                    },
                }),
            ]);
        }
        else if (progress !== train.progress || newWear !== train.wear) {
            await prisma_1.prisma.train.update({
                where: { id: train.id },
                data: { progress, wear: newWear },
            });
        }
    }
}
async function runFreightContracts(weather) {
    const activeContracts = await prisma_1.prisma.contract.findMany({
        where: { status: "EN_COURS" },
        include: { train: true },
    });
    const companiesWithDirecteur = await getCompaniesWithDirecteurCommercial();
    const premiumCompanyIds = await getPremiumCompanyIds();
    const reputationByClient = await getReputationByCompany();
    const cargoIndex = await (0, market_service_1.getCargoIndexMap)();
    const incidentChance = weather === "VERGLAS" ? INCIDENT_CHANCE * 2 : INCIDENT_CHANCE;
    for (const contract of activeContracts) {
        if (!contract.train || !contract.acceptedAt)
            continue;
        // Même risque de retard aléatoire que sur les lignes voyageurs, renforcé par temps de verglas
        if (Math.random() < incidentChance) {
            await prisma_1.prisma.incident.create({
                data: {
                    trainId: contract.train.id,
                    message: `Retard signalé sur le fret : ${contract.train.name} (${contract.cargoType})`,
                },
            });
            continue;
        }
        const elapsedMs = Date.now() - new Date(contract.acceptedAt).getTime();
        const elapsedMinutes = elapsedMs / 60000;
        const progress = Math.min(100, Math.floor((elapsedMinutes / contract.durationMinutes) * 100));
        if (progress >= 100) {
            // Livraison terminée : pour une cargaison fragile, risque de dommage réduisant
            // fortement la récompense et abîmant le train ; sinon récompense pleine.
            // Une rame Fret Lourd rapporte 25% de récompense en plus, le directeur commercial 15% de plus (Premium).
            let baseReward = contract.train.model === "FRET_LOURD" ? Math.round(contract.reward * 1.25) : contract.reward;
            if (companiesWithDirecteur.has(contract.companyId)) {
                baseReward = Math.round(baseReward * 1.15);
            }
            /* Fidélité client : la réputation gagnée en honorant des ordres majore
               le tarif de TOUTES les cargaisons de ce donneur d'ordre. C'est ce qui
               fait de la spécialisation une stratégie et non une collection de primes. */
            const loyalty = (0, client_service_1.cargoBonus)(contract.cargoType, reputationByClient.get(contract.companyId) ?? new Map());
            if (loyalty > 0)
                baseReward = Math.round(baseReward * (1 + loyalty));
            /* Cours du jour : livrer une marchandise recherchée paie mieux que la
               livrer quand personne n'en veut. C'est ce qui relie le tableau des
               cours aux trains, au lieu d'en faire un jeu séparé. */
            const index = cargoIndex.get(contract.cargoType);
            if (index !== undefined)
                baseReward = Math.round(baseReward * (0, market_service_1.freightMultiplier)(index));
            // Une compagnie Premium subit deux fois moins de risque de dommage sur les cargaisons fragiles
            let effectiveDamageChance = premiumCompanyIds.has(contract.companyId) ? DAMAGE_CHANCE / 2 : DAMAGE_CHANCE;
            if (contract.insured)
                effectiveDamageChance /= 2; // la prime d'assurance réduit encore le risque de moitié
            const damaged = contract.risky && Math.random() < effectiveDamageChance;
            const payout = damaged ? Math.round(baseReward * DAMAGE_PAYOUT_RATIO) : baseReward;
            const newWear = damaged ? Math.min(100, contract.train.wear + DAMAGE_WEAR_PENALTY) : contract.train.wear;
            const updates = [
                prisma_1.prisma.contract.update({
                    where: { id: contract.id },
                    data: { status: "LIVREE", trainId: null },
                }),
                prisma_1.prisma.train.update({
                    where: { id: contract.train.id },
                    data: { status: "IDLE", progress: 0, departedAt: null, wear: newWear },
                }),
                prisma_1.prisma.company.update({
                    where: { id: contract.companyId },
                    data: { balance: { increment: payout } },
                }),
                prisma_1.prisma.transaction.create({
                    data: {
                        companyId: contract.companyId,
                        type: "FRET",
                        amount: payout,
                        description: damaged
                            ? `Cargaison endommagée en route : ${contract.cargoType} (${contract.originStation} → ${contract.destinationStation})`
                            : `Livraison "${contract.cargoType}" (${contract.originStation} → ${contract.destinationStation})`,
                    },
                }),
            ];
            if (damaged) {
                updates.push(prisma_1.prisma.incident.create({
                    data: {
                        trainId: contract.train.id,
                        message: `Cargaison fragile endommagée durant le transport : ${contract.cargoType}`,
                    },
                }));
            }
            await prisma_1.prisma.$transaction(updates);
            /* Une cargaison endommagée ne compte pas pour un ordre : le client a
               commandé de la marchandise en bon état, pas des débris. */
            if (!damaged) {
                await (0, mission_service_1.creditDelivery)(contract.companyId, contract.cargoType);
            }
        }
        else if (progress !== contract.train.progress) {
            await prisma_1.prisma.train.update({
                where: { id: contract.train.id },
                data: { progress },
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
async function tryAutoRepair(trainId, companyId, trainName) {
    const [company, chef] = await Promise.all([
        prisma_1.prisma.company.findUnique({ where: { id: companyId }, select: { balance: true } }),
        prisma_1.prisma.staff.findFirst({ where: { companyId, role: "CHEF_DEPOT" }, select: { id: true } }),
    ]);
    if (!company)
        return false;
    const cost = Math.round(100 * (chef ? 1 : 2));
    if (company.balance < cost)
        return false;
    await prisma_1.prisma.$transaction([
        prisma_1.prisma.train.update({ where: { id: trainId }, data: { wear: 0, status: "IDLE", progress: 0, departedAt: null } }),
        prisma_1.prisma.company.update({ where: { id: companyId }, data: { balance: { decrement: cost } } }),
        prisma_1.prisma.transaction.create({
            data: {
                companyId,
                type: "REPARATION",
                amount: -cost,
                description: `Réparation automatique de ${trainName} (Premium)`,
            },
        }),
    ]);
    return true;
}
async function runUpkeep() {
    const companies = await prisma_1.prisma.company.findMany({
        select: { id: true, balance: true, _count: { select: { trains: true } } },
    });
    for (const c of companies) {
        const due = (0, upkeep_service_1.upkeepPerTick)(c._count.trains);
        if (due <= 0)
            continue;
        const paid = Math.min(due, c.balance);
        if (paid > 0) {
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.company.update({ where: { id: c.id }, data: { balance: { decrement: paid } } }),
                prisma_1.prisma.transaction.create({
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
            await prisma_1.prisma.train.updateMany({
                where: { companyId: c.id, status: "EN_ROUTE" },
                data: { wear: { increment: 1 } },
            });
        }
    }
}
async function runPayroll() {
    const staffMembers = await prisma_1.prisma.staff.findMany();
    for (const staff of staffMembers) {
        const company = await prisma_1.prisma.company.findUnique({ where: { id: staff.companyId } });
        if (!company)
            continue;
        if (company.balance < staff.salaryPerTick) {
            // trésorerie insuffisante : l'employé quitte la compagnie
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.staff.delete({ where: { id: staff.id } }),
                prisma_1.prisma.transaction.create({
                    data: {
                        companyId: staff.companyId,
                        type: "PERSONNEL",
                        amount: 0,
                        description: `Un employé a quitté la compagnie faute de trésorerie suffisante`,
                    },
                }),
            ]);
            continue;
        }
        await prisma_1.prisma.company.update({
            where: { id: staff.companyId },
            data: { balance: { decrement: staff.salaryPerTick } },
        });
    }
}
