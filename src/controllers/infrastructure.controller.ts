import { Response } from "express";
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
} from "../services/infrastructure.service";
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
  return prisma.company.findUnique({ where: { ownerId: req.userId as string } }) as Promise<{ id: string; name: string; balance: number } | null>;
}

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
    prisma.stationOwnership.findMany({ select: { station: true, companyId: true, level: true, invested: true, protectedUntil: true, company: { select: { name: true, emblem: true, liveryColor: true } } } }),
    prisma.yard.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "asc" } }),
  ])) as [
    { station: string; level: number; invested: number; protectedUntil: Date; totalFees: number; totalShops: number; pendingFees: number; pendingShops: number; boughtAt: Date }[],
    { id: string; station: string; createdAt: Date }[],
    { id: string; departureStation: string; arrivalStation: string; stops: string[]; electrified: boolean; doubleTrack: boolean; highSpeedAt: Date | null; highSpeedCost: number; _count: { trains: number } }[],
    { station: string; companyId: string; level: number; invested: number; protectedUntil: Date; company: { name: string; emblem: string | null; liveryColor: string } }[],
    { id: string; station: string; createdAt: Date }[]
  ];

  // trafic des dernières 24 h par gare (toutes compagnies), pour juger d'un achat
  const since = new Date(Date.now() - 24 * 3600_000);
  const trips = (await prisma.transaction.findMany({
    where: { type: "REVENU_LIGNE", createdAt: { gte: since } },
    select: { lineId: true },
  })) as { lineId: string | null }[];
  const perLine = new Map<string, number>();
  for (const t of trips) if (t.lineId) perLine.set(t.lineId, (perLine.get(t.lineId) ?? 0) + 1);
  const routes = (await prisma.line.findMany({ where: { id: { in: [...perLine.keys()] } }, select: { id: true, departureStation: true, arrivalStation: true, stops: true } })) as {
    id: string; departureStation: string; arrivalStation: string; stops: string[];
  }[];
  const traffic = new Map<string, number>();
  for (const l of routes) for (const st of new Set(routeOf(l))) traffic.set(st, (traffic.get(st) ?? 0) + (perLine.get(l.id) ?? 0));

  const myStations = new Set(lines.flatMap((l) => routeOf(l)));
  const now = Date.now();

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
    })),
    // le marché : gares de mon réseau et gares les plus fréquentées, avec leur propriétaire éventuel
    market: [...new Set([...myStations, ...[...traffic.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s]) => s)])]
      .filter((s) => isKnownStation(s))
      .map((s) => {
        const o = allOwners.find((x) => x.station === s);
        const mine = o?.companyId === company.id;
        return {
          station: s,
          size: stationSize(s),
          sizeLabel: SIZE_LABEL[stationSize(s)],
          price: o ? Math.round(o.invested * BUYOUT_COST) : stationPrice(s),
          traffic24h: traffic.get(s) ?? 0,
          served: myStations.has(s),
          owner: o && !mine ? { name: o.company.name, emblem: o.company.emblem, liveryColor: o.company.liveryColor, level: o.level } : null,
          mine,
          protectedUntil: o && !mine && new Date(o.protectedUntil).getTime() > now ? o.protectedUntil : null,
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
    | { station: string; companyId: string; invested: number; protectedUntil: Date; company: { name: string } }
    | null;

  if (!current) {
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
  if (new Date(current.protectedUntil).getTime() > Date.now()) {
    return res.status(409).json({ error: `Rachat impossible avant le ${new Date(current.protectedUntil).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })}` });
  }
  /* Rachat : le racheteur paie 1,5 fois ce que la gare a coûté, l'ancien
     propriétaire en touche 1,25 fois. Les sommes en attente lui restent dues. */
  const price = Math.round(current.invested * BUYOUT_COST);
  const payout = Math.round(current.invested * BUYOUT_PAYOUT);
  if (!(await debit(company.id, price))) return res.status(409).json({ error: `Trésorerie insuffisante (${price.toLocaleString("fr-FR")} pi.)` });
  const moved = await prisma.stationOwnership.updateMany({
    where: { station, companyId: current.companyId },
    data: { companyId: company.id, invested: price, protectedUntil: new Date(Date.now() + PROTECTION_MS), boughtAt: new Date(), totalFees: 0, totalShops: 0, protectionNotified: false },
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
