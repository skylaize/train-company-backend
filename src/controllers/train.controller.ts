import { depotUse, heritageOf } from "../services/wreck.service";
import { Prisma } from "@prisma/client";
import { seasonEvent } from "../services/saison.service";
import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { CARS, MAX_CARS, seatsOf } from "../services/ridership.service";
import { prisma } from "../prisma";
import { staffEffectsFor, repairCostPerPoint } from "../services/staff.service";
import { buildLeaderRows } from "../services/leaderboard.service";
import { RANK_DEFINITIONS } from "../services/career.service";
import { DLC_MODELS, ownedDlcs, dlcById } from "../services/dlc.service";
import {
  ORGANS, Organ, PARTS, RepairMode, EXPRESS_MIN, SERVICE_DISCOUNT, SERVICE_THRESHOLDS,
  freshBias, organWear, readStock, stockLimit, takeFromStock, partPrice, partDelayMs, serviceMinutes, backInService, resaleValue,
} from "../services/workshop.service";

async function getOwnedCompanyOrFail(userId: string) {
  return prisma.company.findUnique({ where: { ownerId: userId } });
}

/* Le matériel se débloque au grade de carrière, plus à l'abonnement.
   Deux modèles sur trois étaient marqués Premium alors qu'aucune route ne rend
   une compagnie Premium : personne ne pouvait les acheter, et tout le monde
   roulait en Standard. Le choix de matériel n'existait tout simplement pas. */
export const TRAIN_MODELS: Record<string, { cost: number; minGradeId: number; dlc?: string }> = {
  STANDARD: { cost: 200, minGradeId: 0 },
  EXPRESS: { cost: 450, minGradeId: 1 },   // Gestionnaire confirmé
  FRET_LOURD: { cost: 450, minGradeId: 2 }, // Chef de réseau
  COUCHETTES: { cost: 900, minGradeId: 2 }, // Chef de réseau (1.6) : train de nuit
  // 2.0 : le matériel des extensions (dlc.service)
  ...Object.fromEntries(Object.values(DLC_MODELS).map((m) => [m.id, { cost: m.cost, minGradeId: m.minGradeId, dlc: m.dlc }])),
};

/* 1.6 : la rame couchettes ne fait que les grandes lignes. */
export const NIGHT_MIN_DURATION = 10;

/* 2.0 : une rame de collection ne se déprécie pas avec l'âge : elle se
   reprend à 90 % de ce qu'elle a coûté (rachat et pièces), selon son état. */
function trainValue(t: Parameters<typeof resaleValue>[0] & { heritage?: unknown }) {
  const h = heritageOf(t);
  if (h) return Math.max(10, Math.round(h.value * 0.9 * (1 - Math.min(100, t.wear) / 250)));
  return resaleValue(t, TRAIN_MODELS[t.model]?.cost ?? 200);
}

export async function buyTrain(req: AuthRequest, res: Response) {
  const { name, model } = req.body;
  const chosenModel = model && TRAIN_MODELS[model] ? model : "STANDARD";
  const { cost: TRAIN_COST, minGradeId, dlc } = TRAIN_MODELS[chosenModel];

  if (!name) {
    return res.status(400).json({ error: "Le nom du train est requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  if (dlc && !(await ownedDlcs(company.id)).has(dlc)) {
    return res.status(403).json({ error: `Ce modèle fait partie de l'extension « ${dlcById(dlc)?.name ?? dlc} »` });
  }

  if (minGradeId > 0) {
    const rows = await buildLeaderRows();
    const gradeId = rows.find((r) => r.id === company.id)?.gradeId ?? 0;
    if (gradeId < minGradeId) {
      const needed = RANK_DEFINITIONS[minGradeId]?.name ?? "supérieur";
      return res.status(403).json({ error: `Ce modèle demande le grade « ${needed} »` });
    }
  }

  // 2.0 : une épave en restauration occupe sa place au dépôt
  const trainCount = await depotUse(company.id);
  if (trainCount >= company.maxTrains) {
    return res.status(403).json({ error: `Capacité du dépôt atteinte (${company.maxTrains} places, épaves comprises). Agrandissez-le pour continuer.` });
  }

  if (company.balance < TRAIN_COST) {
    return res.status(409).json({ error: `Trésorerie insuffisante (achat : ${TRAIN_COST} pièces)` });
  }

  const [train] = await prisma.$transaction([
    prisma.train.create({ data: { name, model: chosenModel, companyId: company.id, organs: freshBias() as unknown as Prisma.InputJsonValue } }),
    prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: TRAIN_COST } } }),
    prisma.transaction.create({
      data: {
        companyId: company.id,
        type: "ACHAT_TRAIN",
        amount: -TRAIN_COST,
        description: `Achat de ${name}`,
      },
    }),
  ]);

  return res.status(201).json(train);
}

export async function assignTrainToLine(req: AuthRequest, res: Response) {
  const { trainId, lineId } = req.body;

  if (!trainId || !lineId) {
    return res.status(400).json({ error: "trainId et lineId sont requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) {
    return res.status(404).json({ error: "Train introuvable" });
  }
  if (train.status !== "IDLE") {
    return res.status(409).json({ error: "Ce train est déjà en service (ligne ou fret en cours)" });
  }
  if (train.wear >= 100) {
    return res.status(409).json({ error: "Ce train doit être réparé avant de pouvoir circuler" });
  }

  const line = await prisma.line.findFirst({ where: { id: lineId, companyId: company.id } });
  if (!line) {
    return res.status(404).json({ error: "Ligne introuvable" });
  }
  const dm = DLC_MODELS[train.model];
  if (dm?.minDuration && line.durationMinutes < dm.minDuration) {
    return res.status(409).json({ error: `Une rame ${dm.label.toLowerCase()} ne fait que les lignes d'au moins ${dm.minDuration} minutes` });
  }
  if (train.workshopUntil || train.partsEta) {
    return res.status(409).json({ error: "Cette rame est à l'atelier" });
  }
  if (train.model === "COUCHETTES" && line.durationMinutes < NIGHT_MIN_DURATION) {
    return res.status(409).json({ error: `Une rame couchettes ne fait que les grandes lignes (${NIGHT_MIN_DURATION} min de trajet ou plus)` });
  }

  const updated = await prisma.train.update({
    where: { id: trainId },
    data: {
      lineId,
      status: "EN_ROUTE",
      progress: 0,
      departedAt: new Date(),
      direction: 0, // 1.7 : toute nouvelle affectation commence par l'aller
    },
  });

  return res.json(updated);
}

/* ============================================================
   Composition des rames (1.7) : ajouter ou retirer une voiture.
   Une voiture retirée est reprise à moitié prix.
   ============================================================ */
export async function changeCars(req: AuthRequest, res: Response) {
  const { trainId, car, action } = req.body ?? {};
  const def = CARS[String(car)];
  if (!trainId || !def || (action !== "add" && action !== "remove")) {
    return res.status(400).json({ error: "trainId, car (SECONDE, PREMIERE, BAR) et action (add, remove) sont requis" });
  }
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) return res.status(404).json({ error: "Train introuvable" });
  const cars = [...((train as { cars?: string[] }).cars ?? [])];

  if (action === "add") {
    if (cars.length >= MAX_CARS) return res.status(409).json({ error: `Une rame tire ${MAX_CARS} voitures au plus` });
    if (def.unique && cars.includes(String(car))) return res.status(409).json({ error: `${def.label} : une seule par rame` });
    if (company.balance < def.price) return res.status(409).json({ error: `Trésorerie insuffisante (${def.price} pi.)` });
    cars.push(String(car));
    const done = await prisma.company.updateMany({ where: { id: company.id, balance: { gte: def.price } }, data: { balance: { decrement: def.price } } });
    if (done.count === 0) return res.status(409).json({ error: `Trésorerie insuffisante (${def.price} pi.)` });
    await prisma.$transaction([
      prisma.train.update({ where: { id: train.id }, data: { cars } }),
      prisma.transaction.create({ data: { companyId: company.id, type: "COMPOSITION", amount: -def.price, description: `${def.label} ajoutée à ${train.name}`, trainId: train.id } }),
    ]);
  } else {
    const i = cars.lastIndexOf(String(car));
    if (i < 0) return res.status(409).json({ error: "Cette rame n'a pas cette voiture" });
    cars.splice(i, 1);
    const refund = Math.floor(def.price / 2);
    await prisma.$transaction([
      prisma.train.update({ where: { id: train.id }, data: { cars } }),
      prisma.company.update({ where: { id: company.id }, data: { balance: { increment: refund } } }),
      prisma.transaction.create({ data: { companyId: company.id, type: "COMPOSITION", amount: refund, description: `${def.label} retirée de ${train.name}`, trainId: train.id } }),
    ]);
  }
  return res.json({ cars, seats: seatsOf({ model: train.model, cars }) });
}


const hhmm = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(d);

/* 2.0 : réparer, réviser.

   - Rame en état de marche : « Réviser » l'envoie à l'atelier. La révision
     coûte 60 % d'une réparation par point d'usure, ne demande aucune pièce,
     mais immobilise la rame quelques minutes (3 min + 1 min par 10 %).
   - Rame cassée : il faut la pièce de l'organe qui a lâché. mode = « stock »
     (au magasin : réparée tout de suite), « order » (livrée en 30 à 90 min)
     ou « express » (10 min, 2,5 fois le prix de la pièce). Une commande déjà
     en route peut passer en express contre la différence.
   - Rame en panne d'avant la 2.0 (aucun organe désigné) : réparée comme avant. */
export async function repairTrain(req: AuthRequest, res: Response) {
  const { trainId } = req.body;
  const mode = ["stock", "order", "express"].includes(String(req.body?.mode)) ? (String(req.body.mode) as RepairMode) : null;

  if (!trainId) {
    return res.status(400).json({ error: "trainId est requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) {
    return res.status(404).json({ error: "Train introuvable" });
  }
  if (train.workshopUntil) {
    return res.status(409).json({ error: `${train.name} est déjà en révision, sortie à ${hhmm(train.workshopUntil)}` });
  }

  const costPerPoint = repairCostPerPoint(await staffEffectsFor(company.id));
  const broken = train.status === "MAINTENANCE";
  const part = (train.brokenPart && ORGANS.includes(train.brokenPart as Organ) ? train.brokenPart : null) as Organ | null;

  // une pièce déjà commandée : on peut seulement la faire passer en express
  if (train.partsEta && part) {
    if (mode !== "express") {
      return res.status(409).json({ error: `${PARTS[part].part} en route, livraison à ${hhmm(train.partsEta)}` });
    }
    const extra = partPrice(part, "express") - partPrice(part, "order");
    const expressAt = Date.now() + partDelayMs(part, "express");
    // déjà en express, ou la livraison normale arrive aussi vite : rien à gagner
    if (train.partsEta.getTime() <= expressAt) return res.status(409).json({ error: `La pièce arrive déjà à ${hhmm(train.partsEta)}` });
    if (company.balance < extra) return res.status(409).json({ error: `Trésorerie insuffisante (express : ${extra} pièces de plus)` });
    const eta = new Date(expressAt);
    const claimed = await prisma.train.updateMany({ where: { id: train.id, partsEta: train.partsEta }, data: { partsEta: eta } });
    if (claimed.count === 0) return res.status(409).json({ error: "La commande a déjà changé" });
    const [updated] = await prisma.$transaction([
      prisma.train.findUniqueOrThrow({ where: { id: train.id } }),
      prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: extra } } }),
      prisma.transaction.create({ data: { companyId: company.id, type: "REPARATION", amount: -extra, description: `Livraison express : ${PARTS[part].part} pour ${train.name}`, trainId: train.id, lineId: train.lineId } }),
    ]);
    return res.json(updated);
  }

  /* ---- révision préventive ---- */
  if (!broken) {
    if (train.wear === 0) return res.status(409).json({ error: "Ce train n'a pas besoin de révision" });
    if (train.status === "EN_ROUTE" && !train.lineId) return res.status(409).json({ error: "Cette rame livre du fret : révisez-la à son retour" });
    const cost = Math.ceil(train.wear * costPerPoint * SERVICE_DISCOUNT);
    if (company.balance < cost) return res.status(409).json({ error: `Trésorerie insuffisante (révision : ${cost} pièces)` });
    seasonEvent(company.id, "REVISE");
    const until = new Date(Date.now() + serviceMinutes(train.wear) * 60_000);
    // un double clic n'envoie (et ne facture) qu'une révision
    const claimed = await prisma.train.updateMany({
      where: { id: train.id, workshopUntil: null, status: { not: "MAINTENANCE" } },
      data: { wear: 0, status: "MAINTENANCE", workshopUntil: until, progress: 0, departedAt: null, organs: freshBias() as unknown as Prisma.InputJsonValue },
    });
    if (claimed.count === 0) return res.status(409).json({ error: `${train.name} est déjà à l'atelier` });
    const [updated] = await prisma.$transaction([
      prisma.train.findUniqueOrThrow({ where: { id: train.id } }),
      prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: cost } } }),
      prisma.transaction.create({ data: { companyId: company.id, type: "REPARATION", amount: -cost, description: `Révision de ${train.name} à l'atelier`, trainId: train.id, lineId: train.lineId } }),
    ]);
    return res.json(updated);
  }

  const labor = Math.ceil(train.wear * costPerPoint);

  /* ---- casse d'avant la 2.0, ou rame bloquée : comme avant ---- */
  if (!part) {
    const data: Prisma.TrainUncheckedUpdateInput = { wear: 0, brokenPart: null, ...backInService(train.lineId) };
    if (labor === 0) {
      const updatedTrain = await prisma.train.update({ where: { id: trainId }, data });
      return res.json(updatedTrain);
    }
    if (company.balance < labor) return res.status(409).json({ error: `Trésorerie insuffisante (réparation : ${labor} pièces)` });
    const [updatedTrain] = await prisma.$transaction([
      prisma.train.update({ where: { id: trainId }, data }),
      prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: labor } } }),
      prisma.transaction.create({ data: { companyId: company.id, type: "REPARATION", amount: -labor, description: `Réparation de ${train.name}`, trainId: train.id, lineId: train.lineId } }),
    ]);
    return res.json(updatedTrain);
  }

  /* ---- casse : il faut la pièce ---- */
  const stock = readStock(company.partsStock);
  const chosen: RepairMode | null = mode ?? ((stock[part] ?? 0) > 0 ? "stock" : null);
  if (!chosen) {
    return res.status(409).json({
      error: `Il faut une pièce : ${PARTS[part].part}`,
      needsPart: { part, label: PARTS[part].part, labor, order: partPrice(part, "order"), express: partPrice(part, "express"), delayMin: PARTS[part].delayMin, expressMin: EXPRESS_MIN },
    });
  }

  if (chosen === "stock") {
    if (company.balance < labor) return res.status(409).json({ error: `Trésorerie insuffisante (main-d'œuvre : ${labor} pièces)` });
    if (!(await takeFromStock(company.id, part))) return res.status(409).json({ error: `Plus de ${PARTS[part].plural} en stock` });
    const [updatedTrain] = await prisma.$transaction([
      prisma.train.update({
        where: { id: train.id },
        data: { wear: 0, brokenPart: null, organs: freshBias() as unknown as Prisma.InputJsonValue, ...backInService(train.lineId) },
      }),
      prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: labor } } }),
      prisma.transaction.create({ data: { companyId: company.id, type: "REPARATION", amount: -labor, description: `Réparation de ${train.name}, pièce du magasin (${PARTS[part].part.toLowerCase()})`, trainId: train.id, lineId: train.lineId } }),
    ]);
    return res.json(updatedTrain);
  }

  const cost = labor + partPrice(part, chosen);
  if (company.balance < cost) return res.status(409).json({ error: `Trésorerie insuffisante (${cost} pièces avec la pièce)` });
  const eta = new Date(Date.now() + partDelayMs(part, chosen));
  // une seule commande par panne, même sur un double clic
  const claimed = await prisma.train.updateMany({ where: { id: train.id, partsEta: null, status: "MAINTENANCE" }, data: { partsEta: eta } });
  if (claimed.count === 0) return res.status(409).json({ error: "Une pièce est déjà commandée pour cette rame" });
  const [updatedTrain] = await prisma.$transaction([
    prisma.train.findUniqueOrThrow({ where: { id: train.id } }),
    prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: cost } } }),
    prisma.transaction.create({
      data: {
        companyId: company.id,
        type: "REPARATION",
        amount: -cost,
        description: `${chosen === "express" ? "Commande express" : "Commande"} : ${PARTS[part].part} pour ${train.name}, livrée à ${hhmm(eta)}`,
        trainId: train.id,
        lineId: train.lineId,
      },
    }),
  ]);
  return res.json(updatedTrain);
}

/* 2.0 : révision programmée. La rame passe d'elle-même à l'atelier en fin
   de trajet dès que son usure atteint le seuil (voir simulation.job). */
export async function setServicePlan(req: AuthRequest, res: Response) {
  const { trainId } = req.body ?? {};
  const raw = req.body?.threshold;
  const threshold = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (!trainId) return res.status(400).json({ error: "trainId est requis" });
  if (threshold !== null && !SERVICE_THRESHOLDS.includes(threshold)) {
    return res.status(400).json({ error: `Seuil possible : ${SERVICE_THRESHOLDS.join(", ")} %, ou aucun` });
  }
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const done = await prisma.train.updateMany({ where: { id: trainId, companyId: company.id }, data: { serviceAt: threshold } });
  if (done.count === 0) return res.status(404).json({ error: "Train introuvable" });
  return res.json({ ok: true, serviceAt: threshold });
}

/* 2.0 : le magasin de pièces détachées. */
export async function getParts(req: AuthRequest, res: Response) {
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  return res.json({
    stock: readStock(company.partsStock),
    limit: await stockLimit(company.id),
    catalog: ORGANS.map((id) => ({ id, label: PARTS[id].label, part: PARTS[id].part, price: PARTS[id].price, delayMin: PARTS[id].delayMin, express: partPrice(id, "express"), expressMin: EXPRESS_MIN })),
  });
}

export async function buyParts(req: AuthRequest, res: Response) {
  const part = String(req.body?.part ?? "") as Organ;
  const qty = Math.max(1, Math.min(5, Math.floor(Number(req.body?.qty ?? 1)) || 1));
  if (!ORGANS.includes(part)) return res.status(400).json({ error: "Pièce inconnue" });
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const stock = readStock(company.partsStock);
  const limit = await stockLimit(company.id);
  if ((stock[part] ?? 0) + qty > limit) return res.status(409).json({ error: `Le magasin garde ${limit} ${PARTS[part].plural} au plus` });
  const cost = PARTS[part].price * qty;
  // l'écriture ne passe que si le stock lu n'a pas bougé entre-temps et si la trésorerie suit
  const next = { ...stock, [part]: (stock[part] ?? 0) + qty };
  // stock, trésorerie et ligne de comptes écrits ensemble, ou pas du tout
  const done = await prisma.$transaction(async (tx) => {
    const n = await tx.$executeRaw`
      UPDATE "Company" SET "partsStock" = ${JSON.stringify(next)}::jsonb, "balance" = "balance" - ${cost}
      WHERE "id" = ${company.id} AND "balance" >= ${cost} AND "partsStock" = ${JSON.stringify(company.partsStock ?? {})}::jsonb`;
    if (n > 0) await tx.transaction.create({ data: { companyId: company.id, type: "REPARATION", amount: -cost, description: `Magasin : ${qty} × ${PARTS[part].part.toLowerCase()}` } });
    return n;
  });
  if (done === 0) return res.status(409).json({ error: `Trésorerie insuffisante (${cost} pièces)` });
  return res.json({ stock: next, limit });
}

/* 2.0 : revente d'une rame (Premium). Le prix de reprise baisse avec l'âge
   (65 % du prix neuf, puis 1 % de moins par jour, 30 % au plus bas) et avec
   l'usure ; les voitures attelées sont reprises à moitié prix. */
export async function sellTrain(req: AuthRequest, res: Response) {
  const { trainId } = req.body ?? {};
  if (!trainId) return res.status(400).json({ error: "trainId est requis" });
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  if (!company.isPremium) return res.status(403).json({ error: "La revente des rames est réservée au Premium" });
  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) return res.status(404).json({ error: "Train introuvable" });
  if (train.status === "EN_ROUTE" && !train.lineId) return res.status(409).json({ error: "Cette rame livre du fret : attendez son retour" });
  if (train.partsEta) return res.status(409).json({ error: "Une pièce est en commande pour cette rame" });
  const total = await prisma.train.count({ where: { companyId: company.id } });
  if (total <= 1) return res.status(409).json({ error: "Gardez au moins une rame" });

  const value = trainValue(train);
  await prisma.$transaction([
    prisma.incident.deleteMany({ where: { trainId: train.id } }),
    prisma.staff.updateMany({ where: { companyId: company.id, trainId: train.id }, data: { trainId: null } }),
    prisma.contract.updateMany({ where: { trainId: train.id }, data: { trainId: null } }),
    prisma.train.delete({ where: { id: train.id } }),
    prisma.company.update({ where: { id: company.id }, data: { balance: { increment: value } } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "VENTE_TRAIN", amount: value, description: `Revente de ${train.name}` } }),
  ]);
  return res.json({ ok: true, value });
}

export async function renameTrain(req: AuthRequest, res: Response) {
  const { trainId, name } = req.body;

  if (!trainId || !name) {
    return res.status(400).json({ error: "trainId et name sont requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) {
    return res.status(404).json({ error: "Train introuvable" });
  }

  const updated = await prisma.train.update({ where: { id: trainId }, data: { name } });
  return res.json(updated);
}

export async function releaseTrain(req: AuthRequest, res: Response) {
  const { trainId } = req.body;

  if (!trainId) {
    return res.status(400).json({ error: "trainId est requis" });
  }

  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const train = await prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
  if (!train) {
    return res.status(404).json({ error: "Train introuvable" });
  }
  if (!train.lineId) {
    return res.status(409).json({ error: "Ce train n'est affecté à aucune ligne" });
  }
  if (train.status === "MAINTENANCE") {
    return res.status(409).json({ error: "Ce train est en panne, réparez-le d'abord" });
  }

  const updated = await prisma.train.update({
    where: { id: trainId },
    data: { lineId: null, status: "IDLE", progress: 0, departedAt: null, direction: 0 },
  });

  return res.json(updated);
}

export async function listMyTrains(req: AuthRequest, res: Response) {
  const company = await getOwnedCompanyOrFail(req.userId as string);
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  /* Ordre stable (1.6) : sans tri, Postgres rendait les rames dans l'ordre de
     leur dernière mise à jour, et le tableau se réordonnait sous la souris à
     chaque rafraîchissement — un joueur visait « Affecter » et tombait sur
     la rame voisine. */
  const [trains, crew] = await Promise.all([
    prisma.train.findMany({
      where: { companyId: company.id },
      include: { line: true },
      orderBy: [{ purchasedAt: "asc" }, { name: "asc" }],
    }),
    prisma.staff.findMany({ where: { companyId: company.id, trainId: { not: null } }, select: { id: true, name: true, role: true, level: true, trainId: true } }),
  ]);

  /* 2.0 : l'état de chaque organe, l'équipage, la valeur de reprise. Les
     champs s'ajoutent sans rien retirer : l'ancienne interface les ignore. */
  return res.json(
    trains.map((t) => ({
      ...t,
      organs: organWear(t),
      resaleValue: trainValue(t),
      crew: (crew as { id: string; name: string; role: string; level: number; trainId: string | null }[])
        .filter((c) => c.trainId === t.id)
        .map((c) => ({ id: c.id, name: c.name, role: c.role, level: c.level })),
    }))
  );
}
