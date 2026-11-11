import { Response } from "express";
import { auctionFor, openAuctions, nextMinBid, placeBid } from "../services/auction.service";
import { prisma } from "../prisma";
import { AuthRequest } from "../middleware/auth.middleware";
import { isKnownStation } from "../services/geography.service";
import { stationSize, SIZE_LABEL } from "../services/station.service";
import { routeOf } from "../services/route.service";
import { computeCareerStatus, RANK_DEFINITIONS } from "../services/career.service";
import { sendToCompany } from "../services/push.service";
import {
  electrifyCost,
  routeKmOf,
  stationPrice,
  STATION_PRICE,
  upgradeCost,
  MAX_STATIONS,
  STATION_MAX_LEVEL,
  PROTECTION_MS,
  BUYOUT_COST,
  BUYOUT_PAYOUT,
  SELL_BACK,
  PLATFORM_FEE,
  SHOP_PER_PASSENGER,
  SHOP_LEVEL_MULT,
  HOME_BONUS_STEP,
  HOME_BONUS_CAP,
  WORKSHOP_COST,
  MAX_WORKSHOPS,
  WORKSHOP_WEAR,
  ELECTRIC_SPEED,
  ELECTRIC_WEAR,
  doubleTrackCost,
  DOUBLE_SPEED,
  DOUBLE_DELAY,
  DOUBLE_CADENCE_STEP,
  DOUBLE_CADENCE_CAP,
  YARD_COST,
  MAX_YARDS,
  YARD_PAY,
  YARD_TIME,
  buyoutPrice,
  buyoutPayout,
  stationValue,
  SHOP_SLOTS,
  SHOP_PRICE_SHARE,
  SHOP_SELL_BACK,
  SHOP_RENT,
  SHOPS_PER_RANK_STATION,
  MAX_SHOPS,
  shopSlots,
  shopPrice,
} from "../services/infrastructure.service";
import { inHowLong } from "../services/time.service";
import {
  hslCost, hslDays, hslLineError, hslOpen, hslBuilding, hslReadyAt,
  HSL_MIN_KM, HSL_PER_KM, HSL_MIN_COST, HSL_MIN_GRADE, HSL_KM_PER_DAY, HSL_MIN_DAYS, HSL_MAX_DAYS,
  TGV_COST, TGV_SEATS, TGV_SPEED, TGV_FARE, TGV_WEAR, TGV_MIN_GRADE,
} from "../services/highspeed.service";

/* 2.1 : le plafond de gares suit la carrière. Les derniers grades demandent
   6 puis 10 gares alors qu'on en possédait 4 au plus : on ne pouvait pas les
   atteindre. Le plafond monte à 6 au grade de Maître des caténaires (celui
   qui précède le grade qui en demande 6), puis à 10 au grade de Magnat
   européen (avant celui qui en demande 10). */
const STATION_CAPS: { rank: string; max: number }[] = [
  { rank: "Maître des caténaires", max: 6 },
  { rank: "Magnat européen", max: 10 },
];
async function stationCap(companyId: string) {
  const { currentRank } = await computeCareerStatus(companyId);
  let max = MAX_STATIONS;
  let next: { rank: string; max: number } | null = null;
  for (const c of STATION_CAPS) {
    const idx = RANK_DEFINITIONS.findIndex((r) => r.name === c.rank);
    if (idx >= 0 && currentRank.id >= idx) max = Math.max(max, c.max);
    else if (!next) next = c;
  }
  return { max, next };
}

async function companyOf(req: AuthRequest) {
  return prisma.company.findUnique({ where: { ownerId: req.userId as string } }) as Promise<{ id: string; name: string; balance: number; isPremium: boolean } | null>;
}

/* 2.6 : trafic et voyageurs des dernières 24 h par gare, toutes compagnies.
   Lu dans le remplissage heure par heure (une ligne par ligne et par heure)
   plutôt que dans les écritures : quelques centaines de lignes au lieu de
   dizaines de milliers. Gardé une minute en mémoire. */
let trafficCache: { at: number; traffic: Map<string, number>; passengers: Map<string, number> } | null = null;
async function stationTraffic() {
  if (trafficCache && Date.now() - trafficCache.at < 60_000) return trafficCache;
  const since = new Date(Date.now() - 24 * 3600_000);
  // le résultat est lu à part puis typé : un « as » directement sur groupBy trompe l'inférence de Prisma
  const grouped = await prisma.lineLoadHour.groupBy({ by: ["lineId"], where: { hour: { gte: since } }, _sum: { trips: true, passengers: true } });
  const perLine = grouped as unknown as { lineId: string; _sum: { trips: number | null; passengers: number | null } }[];
  const byId = new Map(perLine.map((r) => [r.lineId, r._sum]));
  const routes = (await prisma.line.findMany({ where: { id: { in: [...byId.keys()] } }, select: { id: true, departureStation: true, arrivalStation: true, stops: true } })) as {
    id: string; departureStation: string; arrivalStation: string; stops: string[];
  }[];
  const traffic = new Map<string, number>();
  const passengers = new Map<string, number>();
  for (const l of routes) {
    const sum = byId.get(l.id);
    for (const st of new Set(routeOf(l))) {
      traffic.set(st, (traffic.get(st) ?? 0) + (sum?.trips ?? 0));
      passengers.set(st, (passengers.get(st) ?? 0) + (sum?.passengers ?? 0));
    }
  }
  trafficCache = { at: Date.now(), traffic, passengers };
  return trafficCache;
}

// 2.6 : gares surveillées
const MAX_WATCHES = 1;
const MAX_WATCHES_PREMIUM = 5;

// débit conditionnel : deux clics simultanés ne peuvent pas passer sous zéro
async function debit(companyId: string, amount: number) {
  const done = await prisma.company.updateMany({ where: { id: companyId, balance: { gte: amount } }, data: { balance: { decrement: amount } } });
  return done.count > 0;
}

/* ---------------- vue d'ensemble ---------------- */

export async function getInfrastructure(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const [owned, workshops, lines, allOwners, yards] = (await Promise.all([
    prisma.stationOwnership.findMany({ where: { companyId: company.id }, orderBy: { boughtAt: "asc" } }),
    prisma.workshop.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "asc" } }),
    prisma.line.findMany({ where: { companyId: company.id }, select: { id: true, departureStation: true, arrivalStation: true, stops: true, electrified: true, doubleTrack: true, highSpeedAt: true, highSpeedCost: true, _count: { select: { trains: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.stationOwnership.findMany({ select: { station: true, companyId: true, level: true, invested: true, legacy: true, protectedUntil: true, company: { select: { name: true, emblem: true, liveryColor: true } } } }),
    prisma.yard.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "asc" } }),
  ])) as [
    { station: string; level: number; invested: number; protectedUntil: Date; totalFees: number; totalShops: number; pendingFees: number; pendingShops: number; boughtAt: Date }[],
    { id: string; station: string; createdAt: Date }[],
    { id: string; departureStation: string; arrivalStation: string; stops: string[]; electrified: boolean; doubleTrack: boolean; highSpeedAt: Date | null; highSpeedCost: number; _count: { trains: number } }[],
    { station: string; companyId: string; level: number; invested: number; legacy: boolean; protectedUntil: Date; company: { name: string; emblem: string | null; liveryColor: string } }[],
    { id: string; station: string; createdAt: Date }[]
  ];

  // trafic des dernières 24 h par gare (toutes compagnies), pour juger d'un achat
  const { traffic, passengers } = await stationTraffic();

  const myStations = new Set(lines.flatMap((l) => routeOf(l)));
  const now = Date.now();

  // 2.6 : les commerces (la table est petite : on la lit en entier)
  const shopRows = (await prisma.stationShop.findMany({ select: { id: true, station: true, companyId: true, price: true, totalIncome: true, pendingIncome: true, boughtAt: true } })) as {
    id: string; station: string; companyId: string; price: number; totalIncome: number; pendingIncome: number; boughtAt: Date;
  }[];
  const takenAt = new Map<string, number>();
  for (const r of shopRows) takenAt.set(r.station, (takenAt.get(r.station) ?? 0) + 1);
  const myShops = shopRows.filter((r) => r.companyId === company.id);
  const myShopAt = new Set(myShops.map((r) => r.station));
  const watches = (await prisma.stationWatch.findMany({ where: { companyId: company.id }, select: { station: true } })) as { station: string }[];
  // 2.7 : les enchères en cours
  const auctions = new Map((await openAuctions()).map((a) => [a.station, a]));
  const shopInfo = (st: string) => ({ slots: shopSlots(st), taken: takenAt.get(st) ?? 0, price: shopPrice(st), mine: myShopAt.has(st) });

  const cap = await stationCap(company.id);
  // 2.2 : grade, et chantier de LGV déjà en cours
  const career = await computeCareerStatus(company.id);
  const hslSite = lines.find((l) => hslBuilding(l));
  return res.json({
    rules: {
      maxStations: cap.max,
      nextStationCap: cap.next, // 2.1 : le grade qui débloque plus de gares
      stationPrices: STATION_PRICE,
      maxLevel: STATION_MAX_LEVEL,
      platformFee: PLATFORM_FEE,
      shopPerPassenger: SHOP_PER_PASSENGER,
      shopLevelMult: SHOP_LEVEL_MULT,
      homeBonusStep: HOME_BONUS_STEP,
      homeBonusCap: HOME_BONUS_CAP,
      buyoutCost: BUYOUT_COST,
      buyoutPayout: BUYOUT_PAYOUT,
      // 2.6 : commerces
      shopSlots: SHOP_SLOTS,
      shopPriceShare: SHOP_PRICE_SHARE,
      shopSellBack: SHOP_SELL_BACK,
      shopRent: SHOP_RENT,
      shopsPerRankStation: SHOPS_PER_RANK_STATION,
      maxShops: MAX_SHOPS,
      maxWatches: company.isPremium ? MAX_WATCHES_PREMIUM : MAX_WATCHES,
      isPremium: Boolean(company.isPremium),
      sellBack: SELL_BACK,
      protectionHours: PROTECTION_MS / 3600_000,
      workshopCost: WORKSHOP_COST,
      maxWorkshops: MAX_WORKSHOPS,
      workshopWear: WORKSHOP_WEAR,
      electricSpeed: ELECTRIC_SPEED,
      electricWear: ELECTRIC_WEAR,
      doubleSpeed: DOUBLE_SPEED,
      doubleDelay: DOUBLE_DELAY,
      cadenceStep: DOUBLE_CADENCE_STEP,
      cadenceCap: DOUBLE_CADENCE_CAP,
      yardCost: YARD_COST,
      maxYards: MAX_YARDS,
      yardPay: YARD_PAY,
      yardTime: YARD_TIME,
      // 2.2 : grande vitesse
      hsl: {
        minKm: HSL_MIN_KM, perKm: HSL_PER_KM, minCost: HSL_MIN_COST, kmPerDay: HSL_KM_PER_DAY, minDays: HSL_MIN_DAYS, maxDays: HSL_MAX_DAYS,
        minGrade: HSL_MIN_GRADE, minGradeName: RANK_DEFINITIONS[HSL_MIN_GRADE]?.name ?? "", gradeOk: career.currentRank.id >= HSL_MIN_GRADE,
        building: hslSite ? { lineId: hslSite.id, route: routeOf(hslSite), openAt: hslSite.highSpeedAt } : null,
        tgv: { cost: TGV_COST, seats: TGV_SEATS, speed: TGV_SPEED, fare: TGV_FARE, wear: TGV_WEAR, minGrade: TGV_MIN_GRADE },
      },
    },
    stations: owned.map((o) => ({
      station: o.station,
      size: stationSize(o.station),
      sizeLabel: SIZE_LABEL[stationSize(o.station)],
      level: o.level,
      invested: o.invested,
      protectedUntil: o.protectedUntil,
      totalFees: o.totalFees + o.pendingFees,
      totalShops: o.totalShops + o.pendingShops,
      boughtAt: o.boughtAt,
      nextUpgrade: o.level < STATION_MAX_LEVEL ? upgradeCost(o.station, o.level + 1) : null,
      sellValue: Math.round(o.invested * SELL_BACK),
      traffic24h: traffic.get(o.station) ?? 0,
      served: myStations.has(o.station),
      // 2.6 : ce que toucherait l'ancien propriétaire en cas de rachat, et les commerces de sa gare
      buyoutPayout: buyoutPayout({ station: o.station, level: o.level, invested: o.invested, legacy: (o as { legacy?: boolean }).legacy }),
      shops: shopInfo(o.station),
    })),
    // 2.6 : mes commerces
    shops: myShops.map((r) => ({
      id: r.id,
      station: r.station,
      sizeLabel: SIZE_LABEL[stationSize(r.station)],
      paid: r.price,
      totalIncome: r.totalIncome + r.pendingIncome,
      boughtAt: r.boughtAt,
      sellValue: Math.round(r.price * SHOP_SELL_BACK),
      traffic24h: traffic.get(r.station) ?? 0,
      ...shopInfo(r.station),
    })),
    watches: watches.map((w) => w.station),
    // le marché : gares de mon réseau et gares les plus fréquentées, avec leur propriétaire éventuel
    market: [...new Set([...myStations, ...[...traffic.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s]) => s), ...watches.map((w) => w.station), ...auctions.keys()])]
      .filter((s) => isKnownStation(s))
      .map((s) => {
        const o = allOwners.find((x) => x.station === s);
        const mine = o?.companyId === company.id;
        return {
          station: s,
          size: stationSize(s),
          sizeLabel: SIZE_LABEL[stationSize(s)],
          price: o ? buyoutPrice(o) : stationPrice(s),
          traffic24h: traffic.get(s) ?? 0,
          served: myStations.has(s),
          owner: o && !mine ? { name: o.company.name, emblem: o.company.emblem, liveryColor: o.company.liveryColor, level: o.level } : null,
          mine,
          protectedUntil: o && !mine && new Date(o.protectedUntil).getTime() > now ? o.protectedUntil : null,
          shops: shopInfo(s),
          watched: watches.some((w) => w.station === s),
          // 2.7 : enchères en cours
          auction: (() => {
            const a = auctions.get(s);
            if (!a || a.ownerId === company.id) return null;
            return { endsAt: a.endsAt, minPrice: a.minPrice, bestBid: a.bestBid, mine: a.bestId === company.id, nextMin: nextMinBid(a) };
          })(),
        };
      })
      .filter((m) => !m.mine)
      .sort((a, b) => Number(b.served) - Number(a.served) || b.traffic24h - a.traffic24h),
    yards: yards.map((y) => ({ id: y.id, station: y.station, createdAt: y.createdAt, served: myStations.has(y.station) })),
    workshops: workshops.map((w) => ({ id: w.id, station: w.station, createdAt: w.createdAt, lines: lines.filter((l) => routeOf(l).includes(w.station)).length })),
    lines: lines.map((l) => {
      const route = routeOf(l);
      return {
        id: l.id, route, km: routeKmOf(route), electrified: l.electrified, cost: electrifyCost(route), doubleTrack: l.doubleTrack, doubleCost: doubleTrackCost(route), trains: l._count.trains,
        // 2.2 : la LGV de la ligne, ouverte, en chantier, ou ce qu'elle coûterait
        hsl: {
          state: hslOpen(l) ? "ouverte" : hslBuilding(l) ? "chantier" : "aucune",
          openAt: l.highSpeedAt,
          cost: l.highSpeedAt ? l.highSpeedCost : hslCost(route),
          days: hslDays(route),
          blocker: l.highSpeedAt ? null : hslLineError(l, route),
        },
      };
    }),
  });
}

/* ---------------- électrification ---------------- */

export async function electrifyLine(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const line = (await prisma.line.findFirst({ where: { id: req.body?.lineId, companyId: company.id } })) as
    | { id: string; departureStation: string; arrivalStation: string; stops: string[]; electrified: boolean }
    | null;
  if (!line) return res.status(404).json({ error: "Ligne introuvable" });
  if (line.electrified) return res.status(409).json({ error: "Cette ligne est déjà électrifiée" });
  const route = routeOf(line);
  const cost = electrifyCost(route);
  if (!(await debit(company.id, cost))) return res.status(409).json({ error: `Trésorerie insuffisante (${cost} pi.)` });
  await prisma.$transaction([
    prisma.line.update({ where: { id: line.id }, data: { electrified: true } }),
    prisma.transaction.create({
      data: { companyId: company.id, type: "ELECTRIFICATION", amount: -cost, lineId: line.id, description: `Électrification : ${route.join(" – ")} (${routeKmOf(route)} km)` },
    }),
  ]);
  return res.json({ ok: true, cost });
}

/* ---------------- 2.1 : double voie ---------------- */

export async function doubleLine(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const line = (await prisma.line.findFirst({ where: { id: req.body?.lineId, companyId: company.id } })) as
    | { id: string; departureStation: string; arrivalStation: string; stops: string[]; doubleTrack: boolean }
    | null;
  if (!line) return res.status(404).json({ error: "Ligne introuvable" });
  if (line.doubleTrack) return res.status(409).json({ error: "Cette ligne est déjà à double voie" });
  const route = routeOf(line);
  const cost = doubleTrackCost(route);
  if (!(await debit(company.id, cost))) return res.status(409).json({ error: `Trésorerie insuffisante (${cost.toLocaleString("fr-FR")} pi.)` });
  const done = await prisma.line.updateMany({ where: { id: line.id, doubleTrack: false }, data: { doubleTrack: true } });
  if (done.count === 0) {
    await prisma.company.update({ where: { id: company.id }, data: { balance: { increment: cost } } });
    return res.status(409).json({ error: "Cette ligne est déjà à double voie" });
  }
  await prisma.transaction.create({
    data: { companyId: company.id, type: "DOUBLE_VOIE", amount: -cost, lineId: line.id, description: `Double voie : ${route.join(" – ")} (${routeKmOf(route)} km)` },
  });
  return res.json({ ok: true, cost });
}

/* ---------------- 2.2 : ligne à grande vitesse ---------------- */

export async function buildHighSpeed(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const line = (await prisma.line.findFirst({ where: { id: req.body?.lineId, companyId: company.id } })) as
    | { id: string; departureStation: string; arrivalStation: string; stops: string[]; electrified: boolean; doubleTrack: boolean; highSpeedAt: Date | null }
    | null;
  if (!line) return res.status(404).json({ error: "Ligne introuvable" });
  const route = routeOf(line);
  const why = hslLineError(line, route);
  if (why) return res.status(409).json({ error: why });
  const { currentRank } = await computeCareerStatus(company.id);
  if (currentRank.id < HSL_MIN_GRADE) return res.status(403).json({ error: `Une LGV demande le grade « ${RANK_DEFINITIONS[HSL_MIN_GRADE]?.name} »` });
  const site = await prisma.line.findFirst({ where: { companyId: company.id, highSpeedAt: { gt: new Date() } }, select: { departureStation: true, arrivalStation: true } });
  if (site) return res.status(409).json({ error: `Un chantier de LGV est déjà en cours (${site.departureStation} – ${site.arrivalStation}) : un seul à la fois` });
  const cost = hslCost(route);
  if (!(await debit(company.id, cost))) return res.status(409).json({ error: `Trésorerie insuffisante (${cost.toLocaleString("fr-FR")} pi.)` });
  const openAt = hslReadyAt(route);
  // écriture conditionnelle : deux clics simultanés ne lancent pas deux chantiers
  const done = await prisma.line.updateMany({ where: { id: line.id, highSpeedAt: null }, data: { highSpeedAt: openAt, highSpeedCost: cost, highSpeedNotified: false } });
  if (done.count === 0) {
    await prisma.company.update({ where: { id: company.id }, data: { balance: { increment: cost } } });
    return res.status(409).json({ error: "Le chantier de la LGV est déjà en cours" });
  }
  await prisma.transaction.create({
    data: { companyId: company.id, type: "LGV", amount: -cost, lineId: line.id, description: `Chantier de LGV : ${route.join(" – ")} (${routeKmOf(route)} km, ${hslDays(route)} jours)` },
  });
  return res.json({ ok: true, cost, openAt });
}

/* ---------------- 2.1 : gares de triage ---------------- */

export async function openYard(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const station = String(req.body?.station ?? "");
  if (!isKnownStation(station)) return res.status(400).json({ error: "Gare inconnue du réseau" });
  const count = await prisma.yard.count({ where: { companyId: company.id } });
  if (count >= MAX_YARDS) return res.status(409).json({ error: `${MAX_YARDS} gares de triage au plus` });
  const exists = await prisma.yard.findFirst({ where: { companyId: company.id, station } });
  if (exists) return res.status(409).json({ error: "Vous avez déjà une gare de triage à " + station });
  if (!(await debit(company.id, YARD_COST))) return res.status(409).json({ error: `Trésorerie insuffisante (${YARD_COST.toLocaleString("fr-FR")} pi.)` });
  try {
    await prisma.$transaction([
      prisma.yard.create({ data: { companyId: company.id, station } }),
      prisma.transaction.create({ data: { companyId: company.id, type: "TRIAGE", amount: -YARD_COST, description: `Gare de triage ouverte à ${station}` } }),
    ]);
  } catch {
    await prisma.company.update({ where: { id: company.id }, data: { balance: { increment: YARD_COST } } });
    return res.status(409).json({ error: "Vous avez déjà une gare de triage à " + station });
  }
  return res.json({ ok: true });
}

export async function closeYard(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const y = (await prisma.yard.findFirst({ where: { id: req.body?.yardId, companyId: company.id } })) as { id: string; station: string } | null;
  if (!y) return res.status(404).json({ error: "Gare de triage introuvable" });
  const value = Math.round(YARD_COST * SELL_BACK);
  const gone = await prisma.yard.deleteMany({ where: { id: y.id, companyId: company.id } });
  if (gone.count === 0) return res.status(409).json({ error: "Gare de triage déjà fermée" });
  await prisma.$transaction([
    prisma.company.update({ where: { id: company.id }, data: { balance: { increment: value } } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "TRIAGE", amount: value, description: `Gare de triage de ${y.station} fermée et revendue` } }),
  ]);
  return res.json({ ok: true, value });
}

/* ---------------- gares ---------------- */

export async function buyStation(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const station = String(req.body?.station ?? "");
  if (!isKnownStation(station)) return res.status(400).json({ error: "Gare inconnue du réseau" });

  const count = await prisma.stationOwnership.count({ where: { companyId: company.id } });
  const cap = await stationCap(company.id);
  if (count >= cap.max)
    return res.status(409).json({
      error: cap.next ? `${cap.max} gares au plus pour l'instant : le grade ${cap.next.rank} en permet ${cap.next.max}` : `${cap.max} gares au plus par compagnie`,
    });

  const current = (await prisma.stationOwnership.findUnique({ where: { station }, include: { company: { select: { name: true } } } })) as
    | { station: string; companyId: string; level: number; invested: number; legacy: boolean; protectedUntil: Date; company: { name: string } }
    | null;

  if (!current) {
    /* 2.4.2 : revendre sa gare juste avant la fin de sa protection puis la
       racheter aussitôt remettait les 72 heures à zéro : la gare ne pouvait
       plus jamais être rachetée. Une gare revendue ne se rachète pas avant
       72 heures par la compagnie qui l'a revendue ; les autres, si. */
    const resold = await prisma.transaction.findFirst({
      where: { companyId: company.id, type: "GARE", createdAt: { gte: new Date(Date.now() - PROTECTION_MS) }, description: `Revente de la gare de ${station}` },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (resold) {
      const until = new Date(resold.createdAt.getTime() + PROTECTION_MS);
      return res.status(409).json({
        error: `Vous avez revendu cette gare : vous pourrez la racheter ${inHowLong(until)}`,
      });
    }
    const price = stationPrice(station);
    if (!(await debit(company.id, price))) return res.status(409).json({ error: `Trésorerie insuffisante (${price.toLocaleString("fr-FR")} pi.)` });
    try {
      await prisma.$transaction([
        prisma.stationOwnership.create({ data: { station, companyId: company.id, invested: price, protectedUntil: new Date(Date.now() + PROTECTION_MS) } }),
        prisma.transaction.create({ data: { companyId: company.id, type: "GARE", amount: -price, description: `Achat de la gare de ${station}` } }),
      ]);
    } catch {
      // un autre joueur l'a achetée à la même seconde : on rembourse
      await prisma.company.update({ where: { id: company.id }, data: { balance: { increment: price } } });
      return res.status(409).json({ error: "Cette gare vient d'être achetée par une autre compagnie" });
    }
    return res.json({ ok: true, price });
  }

  if (current.companyId === company.id) return res.status(409).json({ error: "Cette gare est déjà à vous" });
  // 2.7 : à la fin de la protection, la gare part d'abord aux enchères
  const auction = await auctionFor(station);
  if (auction) return res.status(409).json({ error: "Cette gare est aux enchères : faites une offre" });
  if (new Date(current.protectedUntil).getTime() > Date.now()) {
    return res.status(409).json({ error: `Rachat possible ${inHowLong(new Date(current.protectedUntil))}` });
  }
  /* Rachat : le racheteur paie 1,5 fois ce que la gare a coûté, l'ancien
     propriétaire en touche 1,25 fois. Les sommes en attente lui restent dues. */
  // 2.6 : sur la valeur de la gare, qui ne s'accumule plus ; un propriétaire d'avant la 2.6 garde sa mise
  const price = buyoutPrice(current);
  const payout = buyoutPayout(current);
  if (!(await debit(company.id, price))) return res.status(409).json({ error: `Trésorerie insuffisante (${price.toLocaleString("fr-FR")} pi.)` });
  const moved = await prisma.stationOwnership.updateMany({
    where: { station, companyId: current.companyId },
    data: { companyId: company.id, invested: price, legacy: false, protectedUntil: new Date(Date.now() + PROTECTION_MS), boughtAt: new Date(), totalFees: 0, totalShops: 0, protectionNotified: false },
  });
  if (moved.count === 0) {
    await prisma.company.update({ where: { id: company.id }, data: { balance: { increment: price } } });
    return res.status(409).json({ error: "La gare a changé de mains entre-temps, réessayez" });
  }
  await prisma.$transaction([
    prisma.company.update({ where: { id: current.companyId }, data: { balance: { increment: payout } } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "GARE", amount: -price, description: `Rachat de la gare de ${station} à ${current.company.name}` } }),
    prisma.transaction.create({ data: { companyId: current.companyId, type: "GARE", amount: payout, description: `Gare de ${station} rachetée par ${company.name}` } }),
  ]);
  // Premium : l'ancien propriétaire est prévenu tout de suite (sinon il le lit au grand livre)
  const loser = (await prisma.company.findUnique({ where: { id: current.companyId }, select: { isPremium: true } })) as { isPremium: boolean } | null;
  if (loser?.isPremium) await sendToCompany(current.companyId, {
    title: "Gare rachetée",
    body: `${company.name} vous a racheté la gare de ${station} : ${payout.toLocaleString("fr-FR")} pi. versées.`,
    url: "/dashboard",
    tag: "gares",
  }).catch(() => {});
  return res.json({ ok: true, price });
}

/* 2.7 : une enchère sur une gare dont la protection vient de tomber */
export async function bidStation(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const station = String(req.body?.station ?? "");
  if (!isKnownStation(station)) return res.status(400).json({ error: "Gare inconnue du réseau" });
  const count = await prisma.stationOwnership.count({ where: { companyId: company.id } });
  const cap = await stationCap(company.id);
  if (count >= cap.max) return res.status(409).json({ error: `${cap.max} gares au plus pour l'instant` });
  const r = await placeBid(company, station, Math.round(Number(req.body?.amount)));
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  return res.json(r);
}

export async function upgradeStation(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const station = String(req.body?.station ?? "");
  const own = (await prisma.stationOwnership.findUnique({ where: { station } })) as { companyId: string; level: number } | null;
  if (!own || own.companyId !== company.id) return res.status(404).json({ error: "Cette gare n'est pas à vous" });
  if (own.level >= STATION_MAX_LEVEL) return res.status(409).json({ error: "Commerces déjà au niveau maximum" });
  const cost = upgradeCost(station, own.level + 1);
  if (!(await debit(company.id, cost))) return res.status(409).json({ error: `Trésorerie insuffisante (${cost.toLocaleString("fr-FR")} pi.)` });
  await prisma.$transaction([
    prisma.stationOwnership.update({ where: { station }, data: { level: { increment: 1 }, invested: { increment: cost } } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "GARE", amount: -cost, description: `Agrandissement des commerces : gare de ${station} (niveau ${own.level + 1})` } }),
  ]);
  return res.json({ ok: true, cost });
}

export async function sellStation(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const station = String(req.body?.station ?? "");
  const own = (await prisma.stationOwnership.findUnique({ where: { station } })) as
    | { companyId: string; invested: number; pendingFees: number; pendingShops: number }
    | null;
  if (!own || own.companyId !== company.id) return res.status(404).json({ error: "Cette gare n'est pas à vous" });
  const value = Math.round(own.invested * SELL_BACK) + own.pendingFees + own.pendingShops;
  const gone = await prisma.stationOwnership.deleteMany({ where: { station, companyId: company.id } });
  if (gone.count === 0) return res.status(409).json({ error: "La gare a changé de mains entre-temps" });
  await prisma.$transaction([
    prisma.company.update({ where: { id: company.id }, data: { balance: { increment: value } } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "GARE", amount: value, description: `Revente de la gare de ${station}` } }),
  ]);
  return res.json({ ok: true, value });
}

/* ---------------- 2.6 : commerces ---------------- */

export async function buyShop(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const station = String(req.body?.station ?? "");
  if (!isKnownStation(station)) return res.status(400).json({ error: "Gare inconnue du réseau" });
  const price = shopPrice(station);
  const slots = shopSlots(station);
  if ((await prisma.stationShop.count({ where: { companyId: company.id } })) >= MAX_SHOPS)
    return res.status(409).json({ error: `${MAX_SHOPS} commerces au plus par compagnie : revendez-en un pour en ouvrir un autre` });
  if ((await prisma.stationShop.count({ where: { station } })) >= slots) return res.status(409).json({ error: `Les ${slots} emplacements de la gare de ${station} sont pris` });
  if (!(await debit(company.id, price))) return res.status(409).json({ error: `Trésorerie insuffisante (${price.toLocaleString("fr-FR")} pi.)` });
  try {
    await prisma.$transaction([
      prisma.stationShop.create({ data: { station, companyId: company.id, price } }),
      prisma.transaction.create({ data: { companyId: company.id, type: "GARE", amount: -price, description: `Commerce ouvert : gare de ${station}` } }),
    ]);
  } catch {
    // déjà un commerce dans cette gare (deux clics), ou la dernière place prise à la même seconde
    await prisma.company.update({ where: { id: company.id }, data: { balance: { increment: price } } });
    return res.status(409).json({ error: "Vous avez déjà un commerce dans cette gare" });
  }
  // la dernière place a pu partir à la même seconde : le dernier arrivé est remboursé
  if ((await prisma.stationShop.count({ where: { station } })) > slots) {
    const removed = await prisma.stationShop.deleteMany({ where: { station, companyId: company.id } });
    if (removed.count) {
      await prisma.$transaction([
        prisma.company.update({ where: { id: company.id }, data: { balance: { increment: price } } }),
        prisma.transaction.create({ data: { companyId: company.id, type: "GARE", amount: price, description: `Commerce remboursé : gare de ${station} (complet)` } }),
      ]);
      return res.status(409).json({ error: "La dernière place vient d'être prise" });
    }
  }
  return res.json({ ok: true, price });
}

export async function sellShop(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const station = String(req.body?.station ?? "");
  const shop = (await prisma.stationShop.findUnique({ where: { station_companyId: { station, companyId: company.id } } })) as { id: string; price: number; pendingIncome: number } | null;
  if (!shop) return res.status(404).json({ error: "Vous n'avez pas de commerce dans cette gare" });
  const gone = await prisma.stationShop.deleteMany({ where: { id: shop.id } });
  if (!gone.count) return res.status(409).json({ error: "Commerce déjà revendu" });
  const value = Math.round(shop.price * SHOP_SELL_BACK) + shop.pendingIncome;
  await prisma.$transaction([
    prisma.company.update({ where: { id: company.id }, data: { balance: { increment: value } } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "GARE", amount: value, description: `Commerce revendu : gare de ${station}` } }),
  ]);
  return res.json({ ok: true, value });
}

/* ---------------- 2.6 : surveiller une gare ---------------- */

export async function toggleWatch(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const station = String(req.body?.station ?? "");
  if (!isKnownStation(station)) return res.status(400).json({ error: "Gare inconnue du réseau" });
  const key = { companyId_station: { companyId: company.id, station } };
  if (await prisma.stationWatch.findUnique({ where: key })) {
    await prisma.stationWatch.delete({ where: key });
    return res.json({ ok: true, watching: false });
  }
  const max = company.isPremium ? MAX_WATCHES_PREMIUM : MAX_WATCHES;
  if ((await prisma.stationWatch.count({ where: { companyId: company.id } })) >= max) {
    return res.status(409).json({ error: company.isPremium ? `${max} gares surveillées au plus` : `Une gare surveillée à la fois (cinq avec le Premium)` });
  }
  await prisma.stationWatch.create({ data: { companyId: company.id, station } });
  return res.json({ ok: true, watching: true });
}

/* ---------------- 2.6 (Premium) : le conseiller des commerces ----------------
   Pour chaque gare : ce que rapporterait une place de plus, d'après les
   voyageurs des dernières 24 h, et en combien de jours elle serait payée. */
export async function shopAdvisor(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  if (!company.isPremium) return res.json({ locked: true });
  const [{ passengers }, owners, shops] = (await Promise.all([
    stationTraffic(),
    prisma.stationOwnership.findMany({ select: { station: true, level: true, companyId: true } }),
    prisma.stationShop.groupBy({ by: ["station"], _count: { _all: true } }),
  ])) as [Awaited<ReturnType<typeof stationTraffic>>, { station: string; level: number; companyId: string }[], { station: string; _count: { _all: number } }[]];
  const ownerOf = new Map(owners.map((o) => [o.station, o]));
  const taken = new Map(shops.map((r) => [r.station, r._count._all]));
  const mine = new Set(((await prisma.stationShop.findMany({ where: { companyId: company.id }, select: { station: true } })) as { station: string }[]).map((r) => r.station));
  const rows = [...passengers.entries()]
    .filter(([st]) => isKnownStation(st))
    .map(([st, pax]) => {
      const o = ownerOf.get(st);
      const pool = pax * SHOP_PER_PASSENGER * (SHOP_LEVEL_MULT[o?.level ?? 1] ?? 1);
      const n = taken.get(st) ?? 0;
      const slots = shopSlots(st);
      const keepers = mine.has(st) ? n : n + 1;
      const perDay = Math.round((pool * (o ? 1 - SHOP_RENT : 1)) / Math.max(1, keepers));
      const price = shopPrice(st);
      return {
        station: st,
        sizeLabel: SIZE_LABEL[stationSize(st)],
        passengers24h: pax,
        slots,
        taken: n,
        mine: mine.has(st),
        price,
        perDay,
        paybackDays: perDay > 0 ? Math.round((price / perDay) * 10) / 10 : null,
        ownerLevel: o?.level ?? null,
      };
    })
    .filter((r) => r.mine || r.taken < r.slots)
    .sort((a, b) => (a.paybackDays ?? 1e9) - (b.paybackDays ?? 1e9))
    .slice(0, 25);
  return res.json({ locked: false, rows });
}

/* ---------------- ateliers ---------------- */

export async function openWorkshop(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const station = String(req.body?.station ?? "");
  if (!isKnownStation(station)) return res.status(400).json({ error: "Gare inconnue du réseau" });
  const count = await prisma.workshop.count({ where: { companyId: company.id } });
  if (count >= MAX_WORKSHOPS) return res.status(409).json({ error: `${MAX_WORKSHOPS} ateliers au plus` });
  const exists = await prisma.workshop.findFirst({ where: { companyId: company.id, station } });
  if (exists) return res.status(409).json({ error: "Vous avez déjà un atelier dans cette gare" });
  if (!(await debit(company.id, WORKSHOP_COST))) return res.status(409).json({ error: `Trésorerie insuffisante (${WORKSHOP_COST.toLocaleString("fr-FR")} pi.)` });
  await prisma.$transaction([
    prisma.workshop.create({ data: { companyId: company.id, station } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "ATELIER", amount: -WORKSHOP_COST, description: `Atelier régional ouvert à ${station}` } }),
  ]);
  return res.json({ ok: true });
}

export async function closeWorkshop(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const w = (await prisma.workshop.findFirst({ where: { id: req.body?.workshopId, companyId: company.id } })) as { id: string; station: string } | null;
  if (!w) return res.status(404).json({ error: "Atelier introuvable" });
  const value = Math.round(WORKSHOP_COST * SELL_BACK);
  await prisma.$transaction([
    prisma.workshop.delete({ where: { id: w.id } }),
    prisma.company.update({ where: { id: company.id }, data: { balance: { increment: value } } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "ATELIER", amount: value, description: `Atelier de ${w.station} fermé et revendu` } }),
  ]);
  return res.json({ ok: true, value });
}
