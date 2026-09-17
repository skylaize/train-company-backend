import { prisma } from "../prisma";
import { ensureMarketStocked, removeExpiredContracts } from "../controllers/contract.controller";
import { computeReputation } from "../services/reputation.service";

// Tourne toutes les 30 secondes. Deux types de trajets sont gérés :
// - Ligne voyageurs : service continu, le train repart aussitôt arrivé.
// - Contrat de fret : trajet unique, le train est libéré et la récompense
//   versée à la compagnie une fois la livraison terminée.
// Le marché de contrats est aussi réapprovisionné à chaque tick.

const TICK_INTERVAL_MS = 30_000;

export function startSimulationJob() {
  setInterval(runSimulationTick, TICK_INTERVAL_MS);
  console.log("Simulation du réseau démarrée (tick toutes les 30s)");
}

async function runSimulationTick() {
  await maybeChangeWeather();
  const weather = await getActiveWeather();
  await runLineTrains(weather);
  await runFreightContracts();
  await runPayroll();
  await removeExpiredContracts();
  await ensureMarketStocked();
}

const WEAR_PER_TICK = 2;         // usure gagnée à chaque tick pour un train en service sur une ligne
const INCIDENT_CHANCE = 0.08;    // probabilité qu'un train en ligne subisse un retard ce tick
const REVENUE_PER_MINUTE = 8;    // recette voyageurs par minute de trajet, versée à chaque arrivée
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

async function maybeChangeWeather() {
  const active = await prisma.weatherEvent.findFirst({ where: { endsAt: { gt: new Date() } } });
  if (active) return;

  // ~15% de chance par tick de déclencher un nouvel épisode météo (dure 3 à 6 minutes)
  if (Math.random() < 0.15) {
    const types = ["BROUILLARD", "CANICULE", "VERGLAS"];
    const type = types[Math.floor(Math.random() * types.length)];
    const durationMinutes = 3 + Math.floor(Math.random() * 4);
    await prisma.weatherEvent.create({
      data: { type, endsAt: new Date(Date.now() + durationMinutes * 60_000) },
    });
  }
}

async function getCompaniesWithMecanicien(): Promise<Set<string>> {
  const rows = await prisma.staff.findMany({ where: { role: "MECANICIEN" }, select: { companyId: true } });
  return new Set(rows.map((r) => r.companyId));
}

async function getCompaniesWithDirecteurCommercial(): Promise<Set<string>> {
  const rows = await prisma.staff.findMany({ where: { role: "DIRECTEUR_COMMERCIAL" }, select: { companyId: true } });
  return new Set(rows.map((r) => r.companyId));
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
  const companiesWithMecanicien = await getCompaniesWithMecanicien();
  const companiesWithDirecteur = await getCompaniesWithDirecteurCommercial();
  const premiumCompanyIds = await getPremiumCompanyIds();
  const incidentChance = weather === "VERGLAS" ? INCIDENT_CHANCE * 2 : INCIDENT_CHANCE;

  for (const train of runningTrains) {
    if (!train.line || !train.departedAt) continue;

    // Incident aléatoire : le train est retardé ce tick-ci (pas d'avancée de progression)
    // Par temps de verglas, ce risque est doublé.
    if (Math.random() < incidentChance) {
      await prisma.incident.create({
        data: {
          trainId: train.id,
          message: `Retard signalé : ${train.name} sur ${train.line.departureStation} → ${train.line.arrivalStation}`,
        },
      });
      continue;
    }

    // Par temps de brouillard, un train peut être ralenti (pas d'avancée ce tick, sans pénalité d'usure)
    if (weather === "BROUILLARD" && Math.random() < FOG_SLOWDOWN_CHANCE) {
      continue;
    }

    // Usure du matériel : un mécanicien réduit le rythme d'usure (davantage encore en Premium),
    // une canicule l'accélère au contraire.
    const isPremium = premiumCompanyIds.has(train.companyId);
    let wearRate = WEAR_PER_TICK;
    if (companiesWithMecanicien.has(train.companyId)) {
      wearRate = isPremium ? Math.ceil(WEAR_PER_TICK * 0.3) : Math.ceil(WEAR_PER_TICK / 2);
    }
    if (weather === "CANICULE") wearRate = Math.ceil(wearRate * 1.5);
    const newWear = Math.min(100, train.wear + wearRate);
    if (newWear >= 100) {
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
      const directeurBonus = companiesWithDirecteur.has(train.companyId) ? 1.15 : 1;
      const revenue = Math.round(train.line.durationMinutes * REVENUE_PER_MINUTE * reputationMultiplier * directeurBonus);
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
            description: `Trajet voyageurs : ${train.name} sur ${train.line.departureStation} → ${train.line.arrivalStation}`,
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

async function runFreightContracts() {
  const activeContracts = await prisma.contract.findMany({
    where: { status: "EN_COURS" },
    include: { train: true },
  });
  const companiesWithDirecteur = await getCompaniesWithDirecteurCommercial();
  const premiumCompanyIds = await getPremiumCompanyIds();

  for (const contract of activeContracts) {
    if (!contract.train || !contract.acceptedAt) continue;

    const elapsedMs = Date.now() - new Date(contract.acceptedAt).getTime();
    const elapsedMinutes = elapsedMs / 60_000;
    const progress = Math.min(100, Math.floor((elapsedMinutes / contract.durationMinutes) * 100));

    if (progress >= 100) {
      // Livraison terminée : pour une cargaison fragile, risque de dommage réduisant
      // fortement la récompense et abîmant le train ; sinon récompense pleine.
      // Une rame Fret Lourd rapporte 25% de récompense en plus, le directeur commercial 15% de plus (Premium).
      let baseReward = contract.train.model === "FRET_LOURD" ? Math.round(contract.reward * 1.25) : contract.reward;
      if (companiesWithDirecteur.has(contract.companyId as string)) {
        baseReward = Math.round(baseReward * 1.15);
      }
      // Une compagnie Premium subit deux fois moins de risque de dommage sur les cargaisons fragiles
      const effectiveDamageChance = premiumCompanyIds.has(contract.companyId as string) ? DAMAGE_CHANCE / 2 : DAMAGE_CHANCE;
      const damaged = contract.risky && Math.random() < effectiveDamageChance;
      const payout = damaged ? Math.round(baseReward * DAMAGE_PAYOUT_RATIO) : baseReward;
      const newWear = damaged ? Math.min(100, contract.train.wear + DAMAGE_WEAR_PENALTY) : contract.train.wear;

      const updates = [
        prisma.contract.update({
          where: { id: contract.id },
          data: { status: "LIVREE", trainId: null },
        }),
        prisma.train.update({
          where: { id: contract.train.id },
          data: { status: "IDLE", progress: 0, departedAt: null, wear: newWear },
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
    } else if (progress !== contract.train.progress) {
      await prisma.train.update({
        where: { id: contract.train.id },
        data: { progress },
      });
    }
  }
}

async function runPayroll() {
  const staffMembers = await prisma.staff.findMany();

  for (const staff of staffMembers) {
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
            description: `Un employé a quitté la compagnie faute de trésorerie suffisante`,
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
