import { prisma } from "../prisma";
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
  allies?: Set<string> // 2.0 : pas de redevance de quai entre alliés
) {
  let own = 0;
  const fees: { station: string; ownerId: string; amount: number }[] = [];
  const shops: { station: string; amount: number }[] = [];
  for (const st of new Set(route)) {
    const o = owners.get(st);
    if (!o) continue;
    if (o.companyId === companyId) own += 1;
    else if (!allies?.has(o.companyId)) fees.push({ station: st, ownerId: o.companyId, amount: Math.round(revenue * PLATFORM_FEE) });
    const shop = Math.round(passengers * SHOP_PER_PASSENGER * (SHOP_LEVEL_MULT[o.level] ?? 1));
    if (shop > 0) shops.push({ station: st, amount: shop });
  }
  return { homeBonus: 1 + Math.min(HOME_BONUS_CAP, HOME_BONUS_STEP * own), fees, shops };
}

/* Les sommes dues aux propriétaires s'accumulent pendant l'heure et sont
   versées d'un coup : une écriture par heure plutôt qu'une par train. */
export async function accruePending(pending: Map<string, { fees: number; shops: number }>) {
  for (const [station, p] of pending) {
    if (p.fees <= 0 && p.shops <= 0) continue;
    await prisma.stationOwnership.updateMany({
      where: { station },
      data: { pendingFees: { increment: p.fees }, pendingShops: { increment: p.shops } },
    });
  }
}

export async function payStationIncome() {
  const rows = (await prisma.stationOwnership.findMany({
    where: { OR: [{ pendingFees: { gt: 0 } }, { pendingShops: { gt: 0 } }] },
  })) as { station: string; companyId: string; pendingFees: number; pendingShops: number }[];
  for (const r of rows) {
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
  }
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
  const [stations, workshops, loans, holdings] = (await Promise.all([
    prisma.stationOwnership.findMany({ select: { companyId: true, invested: true } }),
    prisma.workshop.findMany({ select: { companyId: true } }),
    prisma.loan.findMany({ where: { closedAt: null }, select: { companyId: true, remaining: true } }),
    prisma.shareholding.findMany({ select: { holderId: true, shares: true, issuer: { select: { sharePrice: true } } } }),
  ])) as [
    { companyId: string; invested: number }[],
    { companyId: string }[],
    { companyId: string; remaining: number }[],
    { holderId: string; shares: number; issuer: { sharePrice: number } | null }[]
  ];
  const m = new Map<string, number>();
  const add = (id: string, v: number) => m.set(id, (m.get(id) ?? 0) + v);
  for (const s of stations) add(s.companyId, Math.round(s.invested * SELL_BACK));
  for (const w of workshops) add(w.companyId, Math.round(WORKSHOP_COST * SELL_BACK));
  for (const l of loans) add(l.companyId, -l.remaining);
  for (const h of holdings) add(h.holderId, Math.round(h.shares * (h.issuer?.sharePrice ?? 0)));
  return m;
}
