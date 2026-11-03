import { prisma } from "../prisma";
import { Prisma } from "@prisma/client";
import { chunk, row, pool, groupBy, SIM_CONCURRENCY } from "./batch.service";
import { stationSize } from "./station.service";
import { distanceKm } from "./geography.service";

/* ============================================================
   Infrastructures (1.7).

   Trois façons d'investir ailleurs que dans le matériel :

   - ÉLECTRIFIER une ligne : trajets 10 % plus rapides, usure −20 %. Payé au
     kilomètre, perdu si on change les gares de la ligne.
   - ACHETER UNE GARE : ses commerces rapportent à chaque train qui s'y arrête
     (le vôtre comme celui des autres), les autres compagnies vous paient une
     redevance de quai, et vos propres trajets qui la desservent rapportent un
     peu plus. Un concurrent peut vous la racheter, au prix fort, une fois la
     période de protection passée.
   - OUVRIR UN ATELIER RÉGIONAL : vos rames qui desservent sa gare s'usent moins.
   ============================================================ */

/* ---------------- électrification ---------------- */

export const ELECTRIFY_PER_KM = 8;
export const ELECTRIFY_MIN = 600;
export const ELECTRIC_SPEED = 0.9; // durée × 0,9
export const ELECTRIC_WEAR = 0.8; // usure × 0,8

export function routeKmOf(route: string[]) {
  let km = 0;
  for (let i = 0; i < route.length - 1; i++) km += distanceKm(route[i], route[i + 1]) ?? 0;
  return km;
}

export function electrifyCost(route: string[]) {
  return Math.max(ELECTRIFY_MIN, Math.round((routeKmOf(route) * ELECTRIFY_PER_KM) / 10) * 10);
}

/* ---------------- gares ---------------- */

// prix d'achat selon la taille de la gare (1 = petite ville … 5 = capitale)
export const STATION_PRICE: Record<number, number> = { 1: 1500, 2: 3000, 3: 6000, 4: 12000, 5: 25000 };
export const MAX_STATIONS = 4;
export const STATION_MAX_LEVEL = 3;
export const PROTECTION_MS = 72 * 3600_000; // pas de rachat pendant trois jours après un achat
export const BUYOUT_COST = 1.5; // le racheteur paie 1,5 × ce que la gare a coûté
export const BUYOUT_PAYOUT = 1.25; // l'ancien propriétaire touche 1,25 ×
export const SELL_BACK = 0.6; // revente au réseau
export const PLATFORM_FEE = 0.05; // redevance de quai : 5 % de la recette du trajet, par gare
export const SHOP_PER_PASSENGER = 0.04; // pièces par voyageur qui passe en gare, niveau 1
export const SHOP_LEVEL_MULT: Record<number, number> = { 1: 1, 2: 1.8, 3: 2.6 };
export const HOME_BONUS_STEP = 0.05; // vos trajets qui desservent vos gares : +5 % par gare
export const HOME_BONUS_CAP = 0.1;

export function stationPrice(station: string) {
  return STATION_PRICE[stationSize(station)] ?? STATION_PRICE[2];
}

/* ---------------- 2.6 : rachat qui ne s'accumule plus, et commerces ----------------

   Le rachat se payait 1,5 × le dernier prix payé, et ce prix devenait la
   nouvelle base : une gare rachetée dix fois coûtait 57 fois son prix. Il se
   calcule maintenant sur la valeur de la gare (son prix de base et ses
   agrandissements), qui ne bouge plus d'un rachat à l'autre. Les gares
   achetées avant la 2.6 (legacy) gardent la mise de leur propriétaire. */
export function stationValue(station: string, level: number) {
  const base = stationPrice(station);
  return base + (level >= 2 ? upgradeCost(station, 2) : 0) + (level >= 3 ? upgradeCost(station, 3) : 0);
}
export function buyoutPrice(o: { station: string; level: number }) {
  return Math.round(stationValue(o.station, o.level) * BUYOUT_COST);
}
export function buyoutPayout(o: { station: string; level: number; invested: number; legacy?: boolean }) {
  return Math.round(Math.max(stationValue(o.station, o.level), o.legacy ? o.invested : 0) * BUYOUT_PAYOUT);
}

// emplacements de commerce, selon la taille de la gare (environ 380 sur le réseau)
export const SHOP_SLOTS: Record<number, number> = { 5: 16, 4: 12, 3: 8, 2: 6, 1: 4 };
// 3 commerces au plus par compagnie : avec plus de 400 joueurs, les places doivent tourner (Premium compris)
export const MAX_SHOPS = 3;
export const SHOP_PRICE_SHARE = 0.4; // un emplacement : 40 % du prix de base de la gare
export const SHOP_SELL_BACK = 0.6;
export const SHOP_RENT = 0.15; // le loyer du propriétaire de la gare
export const SHOPS_PER_RANK_STATION = 2; // pour les grades, deux commerces comptent pour une gare
export const shopSlots = (station: string) => SHOP_SLOTS[stationSize(station)] ?? 3;
export const shopPrice = (station: string) => Math.round(stationPrice(station) * SHOP_PRICE_SHARE);

/* Les commerçants de chaque gare, chargés une fois par tour (la table est petite). */
export async function stationShops(): Promise<Map<string, string[]>> {
  const rows = (await prisma.stationShop.findMany({ select: { station: true, companyId: true } })) as { station: string; companyId: string }[];
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.station, [...(out.get(r.station) ?? []), r.companyId]);
  return out;
}

// agrandissement vers le niveau `to` (2 ou 3) : la moitié puis la totalité du prix d'achat
export function upgradeCost(station: string, to: number) {
  return Math.round(stationPrice(station) * (to === 2 ? 0.5 : 1));
}

export type OwnerInfo = { companyId: string; level: number };

export async function stationOwners(): Promise<Map<string, OwnerInfo>> {
  const rows = (await prisma.stationOwnership.findMany({ select: { station: true, companyId: true, level: true } })) as {
    station: string;
    companyId: string;
    level: number;
  }[];
  return new Map(rows.map((r) => [r.station, { companyId: r.companyId, level: r.level }]));
}

/* Ce qu'un trajet laisse dans les gares qu'il dessert : bonus pour la
   compagnie chez elle, redevances dues aux autres, et recettes des commerces. */
export function stationEffects(
  route: string[],
  companyId: string,
  revenue: number,
  passengers: number,
  owners: Map<string, OwnerInfo>,
  allies?: Set<string>, // 2.0 : pas de redevance de quai entre alliés
  shopkeepers?: Map<string, string[]> // 2.6 : des commerces peuvent tourner dans une gare sans propriétaire
) {
  let own = 0;
  const fees: { station: string; ownerId: string; amount: number }[] = [];
  const shops: { station: string; amount: number }[] = [];
  for (const st of new Set(route)) {
    const o = owners.get(st);
    if (o) {
      if (o.companyId === companyId) own += 1;
      else if (!allies?.has(o.companyId)) fees.push({ station: st, ownerId: o.companyId, amount: Math.round(revenue * PLATFORM_FEE) });
    } else if (!shopkeepers?.get(st)?.length) continue;
    const shop = Math.round(passengers * SHOP_PER_PASSENGER * (SHOP_LEVEL_MULT[o?.level ?? 1] ?? 1));
    if (shop > 0) shops.push({ station: st, amount: shop });
  }
  return { homeBonus: 1 + Math.min(HOME_BONUS_CAP, HOME_BONUS_STEP * own), fees, shops };
}

/* Les sommes dues aux propriétaires s'accumulent pendant l'heure et sont
   versées d'un coup : une écriture par heure plutôt qu'une par train. */
export async function accruePending(pending: Map<string, { fees: number; shops: number }>, shopkeepers?: Map<string, string[]>, owners?: Map<string, OwnerInfo>) {
  /* 2.6 : ce que dépensent les voyageurs va aux commerçants de la gare, à
     parts égales, moins le loyer du propriétaire. Sans commerçant, le
     propriétaire tient les commerces lui-même et garde tout. Les sommes d'un
     tour sont regroupées par gare avant d'être partagées : une requête. */
  const toShops: [string, string, number][] = [];
  for (const [station, p] of pending) {
    const keepers = shopkeepers?.get(station) ?? [];
    if (!keepers.length || p.shops <= 0) continue;
    const rent = owners?.has(station) ? Math.round(p.shops * SHOP_RENT) : 0; // sans propriétaire, pas de loyer
    const each = Math.floor((p.shops - rent) / keepers.length);
    if (each > 0) for (const c of keepers) toShops.push([station, c, each]);
    p.shops = rent;
  }
  for (const part of chunk(toShops, 500)) {
    await prisma.$executeRaw`
      UPDATE "StationShop" AS s SET "pendingIncome" = s."pendingIncome" + v.amount::int
      FROM (VALUES ${Prisma.join(part.map((r) => row(r)))}) AS v(station, company, amount)
      WHERE s."station" = v.station::text AND s."companyId" = v.company::text`;
  }
  // 2.4 : toutes les gares en une requête
  const rows = [...pending.entries()].filter(([, p]) => p.fees > 0 || p.shops > 0);
  for (const part of chunk(rows, 500)) {
    await prisma.$executeRaw`
      UPDATE "StationOwnership" AS s SET "pendingFees" = s."pendingFees" + v.fees::int, "pendingShops" = s."pendingShops" + v.shops::int
      FROM (VALUES ${Prisma.join(part.map(([station, p]) => row([station, Math.round(p.fees), Math.round(p.shops)])))}) AS v(station, fees, shops)
      WHERE s."station" = v.station::text`;
  }
}

export async function payStationIncome() {
  const rows = (await prisma.stationOwnership.findMany({
    where: { OR: [{ pendingFees: { gt: 0 } }, { pendingShops: { gt: 0 } }] },
  })) as { station: string; companyId: string; pendingFees: number; pendingShops: number }[];
  // 2.4 : plusieurs compagnies à la fois (gares d'une même compagnie en série)
  await pool([...groupBy(rows, (r) => r.companyId).values()], SIM_CONCURRENCY, async (mine) => { for (const r of mine) {
    const ops: any[] = [
      prisma.stationOwnership.update({
        where: { station: r.station },
        data: {
          pendingFees: { decrement: r.pendingFees },
          pendingShops: { decrement: r.pendingShops },
          totalFees: { increment: r.pendingFees },
          totalShops: { increment: r.pendingShops },
        },
      }),
      prisma.company.update({ where: { id: r.companyId }, data: { balance: { increment: r.pendingFees + r.pendingShops } } }),
    ];
    if (r.pendingFees > 0)
      ops.push(prisma.transaction.create({ data: { companyId: r.companyId, type: "REDEVANCE_QUAI", amount: r.pendingFees, description: `Redevances de quai : gare de ${r.station}` } }));
    if (r.pendingShops > 0)
      ops.push(prisma.transaction.create({ data: { companyId: r.companyId, type: "COMMERCES", amount: r.pendingShops, description: `Commerces : gare de ${r.station}` } }));
    await prisma.$transaction(ops);
  } }, "revenus des gares");

  // 2.6 : les commerces, une écriture par compagnie et par heure (toutes ses gares ensemble)
  const shops = (await prisma.stationShop.findMany({ where: { pendingIncome: { gt: 0 } }, select: { id: true, station: true, companyId: true, pendingIncome: true } })) as {
    id: string; station: string; companyId: string; pendingIncome: number;
  }[];
  await pool([...groupBy(shops, (r) => r.companyId).values()], SIM_CONCURRENCY, async (mine) => {
    const total = mine.reduce((a, r) => a + r.pendingIncome, 0);
    await prisma.$transaction([
      ...mine.map((r) => prisma.stationShop.update({ where: { id: r.id }, data: { pendingIncome: { decrement: r.pendingIncome }, totalIncome: { increment: r.pendingIncome } } })),
      prisma.company.update({ where: { id: mine[0].companyId }, data: { balance: { increment: total } } }),
      prisma.transaction.create({
        data: { companyId: mine[0].companyId, type: "COMMERCES", amount: total, description: mine.length === 1 ? `Votre commerce : gare de ${mine[0].station}` : `Vos commerces : ${mine.length} gares` },
      }),
    ] as never);
  }, "revenus des commerces");
}

/* ---------------- 2.1 : double voie ----------------
   Sur une voie unique, les trains se croisent en gare et s'attendent. La
   double voie supprime ces attentes : trajets 7 % plus rapides, retards
   moins fréquents (un train en retard ne bloque plus celui d'en face), et
   le cadencement : chaque rame de plus sur la ligne attire 5 % de
   voyageurs en plus, jusqu'à +15 %. Payée au kilomètre, perdue si l'on
   change les gares de la ligne. */

export const DOUBLE_PER_KM = 14;
export const DOUBLE_MIN = 1200;
export const DOUBLE_SPEED = 0.93;
export const DOUBLE_DELAY = 0.6;
export const DOUBLE_CADENCE_STEP = 0.05;
export const DOUBLE_CADENCE_CAP = 0.15;

export function doubleTrackCost(route: string[]) {
  return Math.max(DOUBLE_MIN, Math.round((routeKmOf(route) * DOUBLE_PER_KM) / 10) * 10);
}

export function cadenceBonus(running: number) {
  return 1 + Math.min(DOUBLE_CADENCE_CAP, DOUBLE_CADENCE_STEP * Math.max(0, running - 1));
}

/* ---------------- 2.1 : gares de triage ---------------- */

export const YARD_COST = 4500;
export const MAX_YARDS = 3;
export const YARD_PAY = 1.12; // fret qui part d'une de vos gares de triage ou y arrive : +12 %
export const YARD_TIME = 0.85; // et la tournée est 15 % plus courte

export async function yardsByCompany(): Promise<Map<string, Set<string>>> {
  const rows = (await prisma.yard.findMany({ select: { companyId: true, station: true } })) as { companyId: string; station: string }[];
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = m.get(r.companyId) ?? new Set<string>();
    set.add(r.station);
    m.set(r.companyId, set);
  }
  return m;
}

export async function yardsOf(companyId: string) {
  const rows = (await prisma.yard.findMany({ where: { companyId }, select: { station: true } })) as { station: string }[];
  return new Set(rows.map((r) => r.station));
}

/* ---------------- ateliers ---------------- */

export const WORKSHOP_COST = 3000;
export const MAX_WORKSHOPS = 3;
export const WORKSHOP_WEAR = 0.75;

export async function workshopsByCompany(): Promise<Map<string, Set<string>>> {
  const rows = (await prisma.workshop.findMany({ select: { companyId: true, station: true } })) as { companyId: string; station: string }[];
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = m.get(r.companyId) ?? new Set<string>();
    set.add(r.station);
    m.set(r.companyId, set);
  }
  return m;
}

/* ---------------- valeur des actifs (classement, bourse) ---------------- */

/* Ce qui s'ajoute à la valeur d'une compagnie au-delà de sa trésorerie et de
   son parc : gares et ateliers (à leur valeur de revente), actions détenues,
   et ce qui est dû à la banque, qui se retranche — sans quoi un emprunt ferait
   grimper la valeur d'autant. */
export async function extraWorth(): Promise<Map<string, number>> {
  const [stations, workshops, loans, holdings, hsl, shops] = (await Promise.all([
    prisma.stationOwnership.findMany({ select: { companyId: true, invested: true } }),
    prisma.workshop.findMany({ select: { companyId: true } }),
    prisma.loan.findMany({ where: { closedAt: null }, select: { companyId: true, remaining: true } }),
    prisma.shareholding.findMany({ select: { holderId: true, shares: true, issuer: { select: { sharePrice: true } } } }),
    // 2.2 : une LGV, même en chantier, compte pour moitié de son prix
    prisma.line.findMany({ where: { highSpeedCost: { gt: 0 } }, select: { companyId: true, highSpeedCost: true } }),
    // 2.6 : un commerce vaut ce qu'il se revend
    prisma.stationShop.findMany({ select: { companyId: true, price: true } }),
  ])) as [
    { companyId: string; invested: number }[],
    { companyId: string }[],
    { companyId: string; remaining: number }[],
    { holderId: string; shares: number; issuer: { sharePrice: number } | null }[],
    { companyId: string; highSpeedCost: number }[],
    { companyId: string; price: number }[]
  ];
  const m = new Map<string, number>();
  const add = (id: string, v: number) => m.set(id, (m.get(id) ?? 0) + v);
  for (const s of stations) add(s.companyId, Math.round(s.invested * SELL_BACK));
  for (const w of workshops) add(w.companyId, Math.round(WORKSHOP_COST * SELL_BACK));
  for (const l of loans) add(l.companyId, -l.remaining);
  for (const h of holdings) add(h.holderId, Math.round(h.shares * (h.issuer?.sharePrice ?? 0)));
  for (const l of hsl) add(l.companyId, Math.round(l.highSpeedCost * 0.5));
  for (const sh of shops) add(sh.companyId, Math.round(sh.price * SHOP_SELL_BACK));
  return m;
}
