import { Response } from "express";
import { Prisma } from "@prisma/client";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { economy, inTrial } from "../services/settings.service";
import {
  PLANT_KINDS, PLANT_LABELS, PlantKind, plantSiteOk, plantSites, plantOutput, dieselPrice, powerPrice, powerProfile,
  loadIndices, energyEvents, outageNow, companyDieselPrice, companyPowerPrice, hourStart,
} from "../services/energy.service";
import { carbonBracket, carbonRate, carbonTax } from "../services/carbon.service";
import { buildLeaderRows } from "../services/leaderboard.service";
import { routeOf } from "../services/route.service";
import { electrifyCost } from "../services/infrastructure.service";
import { weatherMap } from "../services/realweather.service";
import { MARKET_PARTS, partMarketView, partPriceFactor } from "../services/parts-market.service";
import { PARTS, Organ, readStock, stockLimit } from "../services/workshop.service";
import { segmentsOf, segmentKm, segmentCondition, renovationCost, concessionPrice, trackSnapshot } from "../services/track.service";
import { REGIONS, REGION_OF } from "../services/regions.service";

/* ============================================================
   2.4 : le vrai coût du rail, côté joueur.

   Une page « Énergie & carbone » qui répond à trois questions : combien
   me coûtent mes trains, combien je vais payer lundi, et qu'est-ce que je
   peux construire pour payer moins. Plus les pièces et les voies.
   ============================================================ */

const err = (res: Response, status: number, error: string) => res.status(status).json({ error });

async function myCompany(req: AuthRequest) {
  return prisma.company.findUnique({ where: { ownerId: req.userId as string } });
}

async function servedStations(companyId: string) {
  const lines = (await prisma.line.findMany({ where: { companyId }, select: { departureStation: true, arrivalStation: true, stops: true } })) as {
    departureStation: string; arrivalStation: string; stops: string[];
  }[];
  return new Set(lines.flatMap((l) => routeOf(l)));
}

/* Paiement atomique : ne passe que si la trésorerie suit, et les écritures
   liées (création de la centrale, de l'usine…) passent avec, ou pas du tout. */
type TxOp = (tx: Prisma.TransactionClient) => Promise<unknown>;
async function pay(companyId: string, amount: number, type: string, description: string, extra: TxOp[] = []) {
  return prisma.$transaction(async (tx) => {
    if (amount > 0) {
      const done = await tx.company.updateMany({ where: { id: companyId, balance: { gte: amount } }, data: { balance: { decrement: amount } } });
      if (done.count === 0) return false;
      await tx.transaction.create({ data: { companyId, type, amount: -amount, description } });
    }
    for (const op of extra) await op(tx);
    return true;
  });
}

const fmt = (n: number) => Math.round(n).toLocaleString("fr-FR").replace(/[  ]/g, " ");

/* ---------------- la page Énergie & carbone ---------------- */

export async function energyOverview(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const s = economy();
  const now = new Date();
  await loadIndices();
  const ev = await energyEvents();
  const idx = await loadIndices();
  const [meters, plants, history, bills, rows, weather, lines] = await Promise.all([
    prisma.energyMeter.findMany({ where: { companyId: company.id, hour: { gte: new Date(now.getTime() - 48 * 3_600_000) } }, orderBy: { hour: "asc" } }),
    prisma.powerPlant.findMany({ where: { companyId: company.id }, orderBy: { builtAt: "asc" } }),
    prisma.marketIndexHistory.findMany({ where: { at: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, orderBy: { at: "asc" } }),
    prisma.carbonBill.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" }, take: 8 }),
    buildLeaderRows(),
    weatherMap().catch(() => new Map()),
    prisma.line.findMany({ where: { companyId: company.id }, select: { id: true, name: true, departureStation: true, arrivalStation: true, stops: true, electrified: true, durationMinutes: true, highSpeedAt: true } }),
  ]);
  const valuation = Math.round(rows.find((r) => r.id === company.id)?.valeur ?? company.balance);
  const served = new Set(lines.flatMap((l) => routeOf(l as never)));

  // trajets de la semaine par ligne, pour estimer le CO₂ de chaque ligne thermique
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const trips = (await (prisma.transaction.groupBy as any)({
    by: ["lineId"],
    where: { companyId: company.id, type: "REVENU_LIGNE", createdAt: { gte: weekAgo } },
    _count: { _all: true },
  })) as { lineId: string | null; _count: { _all: number } }[];
  const tripsByLine = new Map(trips.map((t) => [t.lineId, t._count._all]));
  const advice = lines
    .filter((l) => !l.electrified && !l.highSpeedAt)
    .map((l) => {
      const n = tripsByLine.get(l.id) ?? 0;
      const liters = n * l.durationMinutes * s.dieselPerMinute;
      const co2 = liters * s.co2PerLiter;
      const kwh = n * l.durationMinutes * s.kwhPerMinute;
      const weeklySaving = Math.round(liters * dieselPrice() - kwh * powerPrice() + co2 * carbonRate(valuation));
      return { lineId: l.id, name: l.name, tripsWeek: n, co2Week: Math.round(co2 * 10) / 10, electrifyCost: electrifyCost(routeOf(l as never)), weeklySaving };
    })
    .filter((a) => a.tripsWeek > 0)
    .sort((a, b) => b.weeklySaving - a.weeklySaving)
    .slice(0, 6);

  const tax = carbonTax(company.co2Week, valuation);
  const o = outageNow(ev, now.getTime());
  const batteryCap = plants.filter((p) => p.kind === "BATTERIE").length * s.plants.BATTERIE.kwh;

  return res.json({
    trial: { active: inTrial(now.getTime()), until: s.trialUntil },
    prices: {
      diesel: { now: dieselPrice(), base: s.dieselBase, shock: idx.diesel.shockLabel, mine: companyDieselPrice(company) },
      power: { now: powerPrice(now), base: s.powerBase, profile: powerProfile(now).label, shock: idx.power.shockLabel, mine: companyPowerPrice(company, now) },
      history: history.map((h) => ({ kind: h.kind, value: h.value, at: h.at })),
      outage: o ? { region: REGIONS.find((r) => r.id === o.region)?.name ?? o.region, until: o.until } : null,
    },
    contracts: {
      diesel: company.dieselFixedUntil && company.dieselFixedUntil > now ? { price: company.dieselFixedPrice, until: company.dieselFixedUntil } : null,
      power: company.powerFixedUntil && company.powerFixedUntil > now ? { price: company.powerFixedPrice, until: company.powerFixedUntil } : null,
      days: s.fixedDays,
      fee: s.fixedFee,
    },
    tank: { tanks: company.dieselTanks, liters: Math.round(company.dieselLiters), capacity: company.dieselTanks * s.tankLiters, tankCost: s.tankCost, tankLiters: s.tankLiters, maxTanks: s.maxTanks },
    battery: { kwh: Math.round(company.batteryKwh), capacity: batteryCap, offPeak: company.batteryOffPeak },
    offerPrice: company.powerOfferPrice,
    fuelBlocked: company.fuelBlocked && !inTrial(now.getTime()),
    meters: meters.map((m) => ({ hour: m.hour, kwh: m.kwh, liters: m.liters, produced: m.produced, co2: m.co2, cost: m.cost, income: m.income, settled: m.settled, trial: m.trial })),
    plants: plants.map((p) => ({
      id: p.id, kind: p.kind, label: PLANT_LABELS[p.kind as PlantKind], station: p.station, produced: Math.round(p.produced),
      outputNow: Math.round(plantOutput(p.kind as PlantKind, weather.get(p.station))), builtAt: p.builtAt,
    })),
    catalog: PLANT_KINDS.map((k) => {
      const sites = plantSites(k);
      return { kind: k, label: PLANT_LABELS[k], cost: s.plants[k].cost, kwh: s.plants[k].kwh, sites: (sites ?? [...served]).filter((st) => served.has(st)), anywhere: sites === null };
    }),
    maxPlants: s.maxPlants,
    carbon: {
      week: Math.round(company.co2Week * 10) / 10,
      quota: s.weeklyQuota,
      valuation,
      rate: Math.round(carbonRate(valuation) * 10) / 10,
      estimate: tax.amount,
      bracket: carbonBracket(valuation),
      brackets: s.carbonBrackets,
      bills: bills.map((b) => ({ week: b.week, emitted: b.emitted, taxable: b.taxable, rate: b.rate, amount: b.amount, trial: b.trial })),
      advice,
    },
  });
}

/* ---------------- gazole ---------------- */

export async function buyTanks(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const s = economy();
  const qty = Math.max(1, Math.min(s.maxTanks, Math.floor(Number(req.body?.qty ?? 1)) || 1));
  if (company.dieselTanks + qty > s.maxTanks) return err(res, 409, `Le dépôt accueille ${s.maxTanks} cuves au plus`);
  const cost = qty * s.tankCost;
  const ok = await pay(company.id, cost, "ENERGIE", `${qty} cuve${qty > 1 ? "s" : ""} de gazole (${fmt(qty * s.tankLiters)} L)`, [
    (tx: Prisma.TransactionClient) => tx.company.update({ where: { id: company.id }, data: { dieselTanks: { increment: qty } } }),
  ]);
  if (!ok) return err(res, 409, `Trésorerie insuffisante (${fmt(cost)} pi.)`);
  return res.json({ ok: true });
}

export async function fillTanks(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const s = economy();
  await loadIndices();
  const room = company.dieselTanks * s.tankLiters - company.dieselLiters;
  if (room < 1) return err(res, 409, company.dieselTanks ? "Les cuves sont pleines" : "Achetez d'abord une cuve");
  const want = req.body?.liters === undefined ? room : Math.max(1, Math.min(room, Number(req.body.liters) || room));
  const price = dieselPrice();
  const cost = Math.round(want * price);
  const ok = await pay(company.id, cost, "ENERGIE", `Plein des cuves : ${fmt(want)} L à ${price.toFixed(2).replace(".", ",")} pi.`, [
    (tx: Prisma.TransactionClient) => tx.company.update({ where: { id: company.id }, data: { dieselLiters: { increment: want } } }),
  ]);
  if (!ok) return err(res, 409, `Trésorerie insuffisante (${fmt(cost)} pi.)`);
  return res.json({ ok: true, liters: want, cost });
}

/* Contrat à prix fixe : le prix du moment, frais compris, pour une semaine. */
export async function lockPrice(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const kind = String(req.body?.kind ?? "");
  if (kind !== "DIESEL" && kind !== "POWER") return err(res, 400, "Contrat inconnu");
  const s = economy();
  await loadIndices();
  const now = new Date();
  const until = new Date(now.getTime() + s.fixedDays * 86_400_000);
  if (kind === "DIESEL") {
    if (company.dieselFixedUntil && company.dieselFixedUntil > now) return err(res, 409, "Un contrat de gazole est déjà en cours");
    const price = Math.round(dieselPrice() * (1 + s.fixedFee) * 1000) / 1000;
    await prisma.company.update({ where: { id: company.id }, data: { dieselFixedPrice: price, dieselFixedUntil: until } });
    return res.json({ ok: true, price, until });
  }
  if (company.powerFixedUntil && company.powerFixedUntil > now) return err(res, 409, "Un contrat d'électricité est déjà en cours");
  // le courant se bloque au prix moyen de la journée (sans le profil horaire), frais compris
  const idx = await loadIndices();
  const price = Math.round(s.powerBase * idx.power.value * idx.power.shock * (1 + s.fixedFee) * 10000) / 10000;
  await prisma.company.update({ where: { id: company.id }, data: { powerFixedPrice: price, powerFixedUntil: until } });
  return res.json({ ok: true, price, until });
}

/* ---------------- centrales ---------------- */

export async function buildPlant(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const s = economy();
  const kind = String(req.body?.kind ?? "") as PlantKind;
  const station = String(req.body?.station ?? "");
  if (!PLANT_KINDS.includes(kind)) return err(res, 400, "Centrale inconnue");
  if (!plantSiteOk(kind, station)) {
    return err(res, 400, kind === "BARRAGE" ? "Un barrage se construit en montagne" : kind === "SOLAIRE" ? "Un parc solaire se construit dans le Sud" : "Des éoliennes se construisent sur la côte ou dans le Nord");
  }
  if (!(await servedStations(company.id)).has(station)) return err(res, 409, `Desservez d'abord ${station}`);
  const count = await prisma.powerPlant.count({ where: { companyId: company.id } });
  if (count >= s.maxPlants) return err(res, 409, `${s.maxPlants} centrales au plus`);
  const cost = s.plants[kind].cost;
  const ok = await pay(company.id, cost, "CENTRALE", `${PLANT_LABELS[kind]} à ${station}`, [
    (tx: Prisma.TransactionClient) => tx.powerPlant.create({ data: { companyId: company.id, kind, station } }),
  ]);
  if (!ok) return err(res, 409, `Trésorerie insuffisante (${fmt(cost)} pi.)`);
  return res.status(201).json({ ok: true });
}

export async function sellPlant(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const p = await prisma.powerPlant.findFirst({ where: { id: String(req.params.id), companyId: company.id } });
  if (!p) return err(res, 404, "Centrale introuvable");
  const back = Math.round((economy().plants[p.kind]?.cost ?? 0) * 0.5);
  await prisma.$transaction([
    prisma.powerPlant.delete({ where: { id: p.id } }),
    prisma.company.update({ where: { id: company.id }, data: { balance: { increment: back } } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "CENTRALE", amount: back, description: `Revente : ${PLANT_LABELS[p.kind as PlantKind]} à ${p.station}` } }),
  ]);
  // la batterie retirée perd ce qu'elle stockait au-delà de la nouvelle capacité
  const cap = (await prisma.powerPlant.count({ where: { companyId: company.id, kind: "BATTERIE" } })) * economy().plants.BATTERIE.kwh;
  await prisma.company.updateMany({ where: { id: company.id, batteryKwh: { gt: cap } }, data: { batteryKwh: cap } });
  return res.json({ ok: true, refund: back });
}

export async function energySettings(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const data: Prisma.CompanyUpdateInput = {};
  if (typeof req.body?.batteryOffPeak === "boolean") data.batteryOffPeak = req.body.batteryOffPeak;
  if ("offerPrice" in (req.body ?? {})) {
    const v = req.body.offerPrice;
    if (v === null) data.powerOfferPrice = null;
    else {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 2) return err(res, 400, "Prix de vente invalide");
      data.powerOfferPrice = Math.round(n * 1000) / 1000;
    }
  }
  await prisma.company.update({ where: { id: company.id }, data });
  return res.json({ ok: true });
}

/* ---------------- pièces détachées ---------------- */

export async function partsOverview(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const s = economy();
  const [factories, listings, served, limit] = await Promise.all([
    prisma.partFactory.findMany({ where: { companyId: company.id }, orderBy: { builtAt: "asc" } }),
    prisma.partFactory.findMany({
      where: { companyId: { not: company.id }, salePrice: { not: null }, stored: { gt: 0 } },
      orderBy: { salePrice: "asc" },
      take: 40,
      select: { id: true, part: true, stored: true, salePrice: true, station: true, company: { select: { name: true, liveryColor: true } } },
    }),
    servedStations(company.id),
    stockLimit(company.id),
  ]);
  const every = 24 / Math.max(1, s.factoryPerDay);
  return res.json({
    market: partMarketView().map((m) => ({ ...m, label: PARTS[m.part as Organ].label, part_name: PARTS[m.part as Organ].part, basePrice: PARTS[m.part as Organ].price, price: Math.round(PARTS[m.part as Organ].price * partPriceFactor(m.part)) })),
    stock: readStock(company.partsStock),
    limit,
    factories: factories.map((f) => ({ id: f.id, part: f.part, label: PARTS[f.part as Organ]?.part ?? f.part, station: f.station, stored: f.stored, salePrice: f.salePrice, nextIn: Math.max(0, Math.round((f.producedAt.getTime() + every * 3_600_000 - Date.now()) / 60_000)) })),
    listings: listings.map((l) => ({ id: l.id, part: l.part, label: PARTS[l.part as Organ]?.part ?? l.part, stored: l.stored, price: l.salePrice, station: l.station, seller: l.company.name, livery: l.company.liveryColor })),
    factory: { cost: s.factoryCost, perDay: s.factoryPerDay, storeMax: s.factoryStoreMax, max: s.maxFactories, stations: [...served] },
  });
}

export async function buildFactory(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const s = economy();
  const part = String(req.body?.part ?? "");
  const station = String(req.body?.station ?? "");
  if (!(MARKET_PARTS as readonly string[]).includes(part)) return err(res, 400, "Pièce inconnue");
  if (!(await servedStations(company.id)).has(station)) return err(res, 409, `Desservez d'abord ${station}`);
  if ((await prisma.partFactory.count({ where: { companyId: company.id } })) >= s.maxFactories) return err(res, 409, `${s.maxFactories} usines au plus`);
  const ok = await pay(company.id, s.factoryCost, "USINE", `Usine de ${PARTS[part as Organ].plural} à ${station}`, [
    (tx: Prisma.TransactionClient) => tx.partFactory.create({ data: { companyId: company.id, part, station } }),
  ]);
  if (!ok) return err(res, 409, `Trésorerie insuffisante (${fmt(s.factoryCost)} pi.)`);
  return res.status(201).json({ ok: true });
}

export async function updateFactory(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const f = await prisma.partFactory.findFirst({ where: { id: String(req.params.id), companyId: company.id } });
  if (!f) return err(res, 404, "Usine introuvable");
  const v = req.body?.salePrice;
  let salePrice: number | null = null;
  if (v !== null && v !== undefined) {
    salePrice = Math.floor(Number(v));
    if (!Number.isFinite(salePrice) || salePrice < 1 || salePrice > 5000) return err(res, 400, "Prix invalide");
  }
  await prisma.partFactory.update({ where: { id: f.id }, data: { salePrice } });
  return res.json({ ok: true });
}

/* Ranger la production dans son magasin (dans la limite du magasin). */
export async function collectFactory(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const f = await prisma.partFactory.findFirst({ where: { id: String(req.params.id), companyId: company.id } });
  if (!f) return err(res, 404, "Usine introuvable");
  const stock = readStock(company.partsStock);
  const limit = await stockLimit(company.id);
  const part = f.part as Organ;
  const qty = Math.min(f.stored, Math.max(0, limit - (stock[part] ?? 0)));
  if (qty <= 0) return err(res, 409, f.stored ? "Le magasin est plein pour cette pièce" : "Rien à ranger pour l'instant");
  const next = { ...stock, [part]: (stock[part] ?? 0) + qty };
  const done = await prisma.$transaction(async (tx) => {
    const a = await tx.partFactory.updateMany({ where: { id: f.id, stored: { gte: qty } }, data: { stored: { decrement: qty } } });
    if (!a.count) return 0;
    return tx.$executeRaw`UPDATE "Company" SET "partsStock" = ${JSON.stringify(next)}::jsonb WHERE "id" = ${company.id} AND "partsStock" = ${JSON.stringify(company.partsStock ?? {})}::jsonb`;
  });
  if (!done) return err(res, 409, "Le stock a changé, réessayez");
  return res.json({ ok: true, qty, stock: next });
}

/* Acheter des pièces à l'usine d'un autre joueur. */
export async function buyFromPlayer(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const f = await prisma.partFactory.findUnique({ where: { id: String(req.body?.factoryId ?? "") } });
  if (!f || f.salePrice === null || f.companyId === company.id) return err(res, 404, "Offre introuvable");
  const part = f.part as Organ;
  const stock = readStock(company.partsStock);
  const limit = await stockLimit(company.id);
  const qty = Math.max(1, Math.min(f.stored, limit - (stock[part] ?? 0), Math.floor(Number(req.body?.qty ?? 1)) || 1));
  if (qty <= 0 || f.stored <= 0) return err(res, 409, "Plus rien à vendre, ou votre magasin est plein");
  const cost = qty * f.salePrice;
  const next = { ...stock, [part]: (stock[part] ?? 0) + qty };
  const done = await prisma.$transaction(async (tx) => {
    const a = await tx.partFactory.updateMany({ where: { id: f.id, stored: { gte: qty }, salePrice: f.salePrice }, data: { stored: { decrement: qty } } });
    if (!a.count) return 0;
    const b = await tx.$executeRaw`
      UPDATE "Company" SET "partsStock" = ${JSON.stringify(next)}::jsonb, "balance" = "balance" - ${cost}
      WHERE "id" = ${company.id} AND "balance" >= ${cost} AND "partsStock" = ${JSON.stringify(company.partsStock ?? {})}::jsonb`;
    if (!b) throw new Error("retry");
    await tx.company.update({ where: { id: f.companyId }, data: { balance: { increment: cost } } });
    await tx.transaction.create({ data: { companyId: company.id, type: "REPARATION", amount: -cost, description: `Pièces achetées à un joueur : ${qty} × ${PARTS[part].part.toLowerCase()}` } });
    await tx.transaction.create({ data: { companyId: f.companyId, type: "USINE", amount: cost, description: `Vente de ${qty} × ${PARTS[part].part.toLowerCase()} (usine de ${f.station})` } });
    return 1;
  }).catch(() => 0);
  if (!done) return err(res, 409, `Achat impossible (trésorerie : ${fmt(cost)} pi. nécessaires, ou l'offre a changé)`);
  return res.json({ ok: true, qty, cost, stock: next });
}

/* ---------------- voies et concessions ---------------- */

export async function trackOverview(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const s = economy();
  const lines = (await prisma.line.findMany({ where: { companyId: company.id }, select: { name: true, departureStation: true, arrivalStation: true, stops: true } })) as {
    name: string; departureStation: string; arrivalStation: string; stops: string[];
  }[];
  const keys = new Map<string, string[]>();
  for (const l of lines) for (const k of segmentsOf(routeOf(l))) keys.set(k, [...(keys.get(k) ?? []), l.name]);
  const mine = (await prisma.concession.findMany({ where: { companyId: company.id }, select: { segmentKey: true } })) as { segmentKey: string }[];
  for (const c of mine) if (!keys.has(c.segmentKey)) keys.set(c.segmentKey, []);
  const rows = (await prisma.trackSegment.findMany({
    where: { key: { in: [...keys.keys()] } },
    include: { concession: { include: { company: { select: { name: true, liveryColor: true } } } } },
  })) as any[];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // ma part de la cagnotte en cours, par liaison
  const myFunds = (await (prisma.trackFunding.groupBy as any)({ by: ["segmentKey", "round"], where: { companyId: company.id, segmentKey: { in: [...keys.keys()] } }, _sum: { amount: true } })) as {
    segmentKey: string; round: number; _sum: { amount: number | null };
  }[];
  const now = Date.now();
  const segments = [...keys.entries()].map(([key, lineNames]) => {
    const r = byKey.get(key);
    const condition = r?.condition ?? 100;
    const round = r?.round ?? 0;
    const c = r?.concession ?? null;
    return {
      key,
      label: key.replace("|", " – "),
      km: Math.round(segmentKm(key)),
      condition: Math.round(condition * 10) / 10,
      lines: lineNames,
      fund: r?.fund ?? 0,
      myFund: myFunds.find((f) => f.segmentKey === key && f.round === round)?._sum.amount ?? 0,
      renovationCost: renovationCost(key, condition),
      concession: c
        ? { id: c.id, mine: c.companyId === company.id, owner: c.company.name, livery: c.company.liveryColor, toll: c.toll, totalTolls: c.totalTolls, protectedUntil: c.protectedUntil, lowSince: c.lowSince, invested: c.invested, buyout: Math.round(c.invested * s.concessionBuyout), canBuyout: c.companyId !== company.id && new Date(c.protectedUntil).getTime() <= now }
        : null,
      price: concessionPrice(key),
    };
  });
  segments.sort((a, b) => a.condition - b.condition);
  return res.json({
    segments,
    rules: {
      slowFrom: s.trackSlowFrom, slowFactor: s.trackSlowFactor, badFrom: s.trackBadFrom, badFactor: s.trackBadFactor,
      cofunderShare: s.cofunderShare, cofunderBonus: s.cofunderBonus, cofunderDays: s.cofunderDays,
      maxToll: s.maxToll, minCondition: s.concessionMinCondition, graceHours: s.concessionGraceHours, maxConcessions: s.maxConcessions,
      buyout: s.concessionBuyout, payout: s.concessionPayout, protectionHours: s.concessionProtectionHours,
    },
    myConcessions: mine.length,
  });
}

/* Verser dans la cagnotte de rénovation d'une liaison. Quand elle couvre le
   chantier, la voie repasse à 100 % aussitôt. */
export async function fundTrack(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const key = String(req.body?.key ?? "");
  const [a, b] = key.split("|");
  if (!a || !b || segmentKm(key) <= 0) return err(res, 400, "Liaison inconnue");
  const seg = await prisma.trackSegment.upsert({ where: { key }, create: { key }, update: {} });
  const cost = renovationCost(key, seg.condition);
  if (seg.condition >= 99.5) return err(res, 409, "Cette voie est déjà en parfait état");
  const remaining = Math.max(0, cost - seg.fund);
  const amount = Math.max(1, Math.min(remaining, Math.floor(Number(req.body?.amount ?? remaining)) || remaining));
  const done = await pay(company.id, amount, "RENOVATION", `Rénovation de la voie ${a} – ${b}`, [
    (tx: Prisma.TransactionClient) => tx.trackFunding.create({ data: { segmentKey: key, companyId: company.id, amount, round: seg.round } }),
    (tx: Prisma.TransactionClient) => tx.trackSegment.update({ where: { key }, data: { fund: { increment: amount } } }),
  ]);
  if (!done) return err(res, 409, `Trésorerie insuffisante (${fmt(amount)} pi.)`);
  // la cagnotte couvre le chantier : la voie est refaite
  const after = await prisma.trackSegment.findUnique({ where: { key } });
  let renovated = false;
  if (after && after.fund >= renovationCost(key, after.condition)) {
    const r = await prisma.trackSegment.updateMany({ where: { key, round: after.round }, data: { condition: 100, fund: 0, round: { increment: 1 }, renovatedAt: new Date() } });
    renovated = r.count > 0;
  }
  return res.json({ ok: true, amount, renovated });
}

export async function buyConcession(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const s = economy();
  const key = String(req.body?.key ?? "");
  if (segmentKm(key) <= 0) return err(res, 400, "Liaison inconnue");
  if (!(await servedStations(company.id)).has(key.split("|")[0]) && !(await servedStations(company.id)).has(key.split("|")[1])) {
    return err(res, 409, "Desservez au moins une des deux gares");
  }
  await prisma.trackSegment.upsert({ where: { key }, create: { key }, update: {} });
  const existing = await prisma.concession.findUnique({ where: { segmentKey: key } });
  const protectedUntil = new Date(Date.now() + s.concessionProtectionHours * 3_600_000);
  if (!existing) {
    if ((await prisma.concession.count({ where: { companyId: company.id } })) >= s.maxConcessions) return err(res, 409, `${s.maxConcessions} concessions au plus`);
    const price = concessionPrice(key);
    try {
      const ok = await pay(company.id, price, "CONCESSION", `Concession de la liaison ${key.replace("|", " – ")}`, [
        (tx: Prisma.TransactionClient) => tx.concession.create({ data: { segmentKey: key, companyId: company.id, invested: price, protectedUntil } }),
      ]);
      if (!ok) return err(res, 409, `Trésorerie insuffisante (${fmt(price)} pi.)`);
    } catch {
      return err(res, 409, "Quelqu'un vient de prendre cette concession");
    }
    return res.status(201).json({ ok: true });
  }
  // rachat à un concurrent, une fois la protection passée
  if (existing.companyId === company.id) return err(res, 409, "Cette concession est déjà à vous");
  if (existing.protectedUntil.getTime() > Date.now()) return err(res, 409, "Cette concession vient de changer de main, elle est protégée trois jours");
  if ((await prisma.concession.count({ where: { companyId: company.id } })) >= s.maxConcessions) return err(res, 409, `${s.maxConcessions} concessions au plus`);
  const buyout = Math.round(existing.invested * s.concessionBuyout);
  const payout = Math.round(existing.invested * s.concessionPayout);
  const ok = await pay(company.id, buyout, "CONCESSION", `Rachat de la concession ${key.replace("|", " – ")}`, [
    async (tx: Prisma.TransactionClient) => {
      const moved = await tx.concession.updateMany({ where: { id: existing.id, companyId: existing.companyId }, data: { companyId: company.id, invested: buyout, protectedUntil, lowSince: null } });
      if (!moved.count) throw new Error("changed");
      await tx.company.update({ where: { id: existing.companyId }, data: { balance: { increment: payout } } });
      await tx.transaction.create({ data: { companyId: existing.companyId, type: "CONCESSION", amount: payout, description: `Concession ${key.replace("|", " – ")} rachetée par ${company.name}` } });
    },
  ]).catch(() => false);
  if (!ok) return err(res, 409, `Rachat impossible (${fmt(buyout)} pi. nécessaires, ou la concession a changé)`);
  return res.json({ ok: true });
}

export async function updateConcession(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const toll = Number(req.body?.toll);
  if (!Number.isFinite(toll) || toll < 0 || toll > economy().maxToll) return err(res, 400, `Péage entre 0 et ${Math.round(economy().maxToll * 100)} %`);
  const done = await prisma.concession.updateMany({ where: { id: String(req.params.id), companyId: company.id }, data: { toll: Math.round(toll * 1000) / 1000 } });
  if (!done.count) return err(res, 404, "Concession introuvable");
  return res.json({ ok: true });
}

export async function sellConcession(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const c = await prisma.concession.findFirst({ where: { id: String(req.params.id), companyId: company.id } });
  if (!c) return err(res, 404, "Concession introuvable");
  const back = Math.round(c.invested * 0.6);
  await prisma.$transaction([
    prisma.concession.delete({ where: { id: c.id } }),
    prisma.company.update({ where: { id: company.id }, data: { balance: { increment: back + c.pending } } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "CONCESSION", amount: back + c.pending, description: `Concession ${c.segmentKey.replace("|", " – ")} rendue au réseau` } }),
  ]);
  return res.json({ ok: true, refund: back });
}

/* ---------------- pour la carte : l'état des voies empruntées ---------------- */

export async function trackMap(req: AuthRequest, res: Response) {
  const snap = trackSnapshot();
  /* 2.4.1 : seules les concessions du joueur sont marquées. Celles de tout le
     réseau dessinaient de gros traits dorés partout sur la carte, et les
     joueurs s'en plaignaient. */
  const me = (await myCompany(req).catch(() => null))?.id ?? null;
  return res.json({
    segments: [...snap.entries()]
      .filter(([, v]) => v.condition < 99 || (me && v.concession?.companyId === me))
      .map(([key, v]) => ({ key, condition: Math.round(v.condition), concession: Boolean(me && v.concession?.companyId === me) })),
    outage: outageNow()?.region ?? null,
    regions: Object.fromEntries(Object.entries(REGION_OF)),
    hour: hourStart().toISOString(),
  });
}

export { segmentCondition };
