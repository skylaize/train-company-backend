import { Response } from "express";
import { prisma } from "../prisma";
import { AuthRequest } from "../middleware/auth.middleware";
import { isKnownStation } from "../services/geography.service";
import { stationSize, SIZE_LABEL } from "../services/station.service";
import { routeOf } from "../services/route.service";
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
} from "../services/infrastructure.service";

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

  const [owned, workshops, lines, allOwners] = (await Promise.all([
    prisma.stationOwnership.findMany({ where: { companyId: company.id }, orderBy: { boughtAt: "asc" } }),
    prisma.workshop.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "asc" } }),
    prisma.line.findMany({ where: { companyId: company.id }, select: { id: true, departureStation: true, arrivalStation: true, stops: true, electrified: true }, orderBy: { createdAt: "asc" } }),
    prisma.stationOwnership.findMany({ select: { station: true, companyId: true, level: true, invested: true, protectedUntil: true, company: { select: { name: true, emblem: true, liveryColor: true } } } }),
  ])) as [
    { station: string; level: number; invested: number; protectedUntil: Date; totalFees: number; totalShops: number; pendingFees: number; pendingShops: number; boughtAt: Date }[],
    { id: string; station: string; createdAt: Date }[],
    { id: string; departureStation: string; arrivalStation: string; stops: string[]; electrified: boolean }[],
    { station: string; companyId: string; level: number; invested: number; protectedUntil: Date; company: { name: string; emblem: string | null; liveryColor: string } }[]
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

  return res.json({
    rules: {
      maxStations: MAX_STATIONS,
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
    workshops: workshops.map((w) => ({ id: w.id, station: w.station, createdAt: w.createdAt, lines: lines.filter((l) => routeOf(l).includes(w.station)).length })),
    lines: lines.map((l) => {
      const route = routeOf(l);
      return { id: l.id, route, km: routeKmOf(route), electrified: l.electrified, cost: electrifyCost(route) };
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

/* ---------------- gares ---------------- */

export async function buyStation(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const station = String(req.body?.station ?? "");
  if (!isKnownStation(station)) return res.status(400).json({ error: "Gare inconnue du réseau" });

  const count = await prisma.stationOwnership.count({ where: { companyId: company.id } });
  if (count >= MAX_STATIONS) return res.status(409).json({ error: `${MAX_STATIONS} gares au plus par compagnie` });

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
