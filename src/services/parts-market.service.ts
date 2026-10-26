import { prisma } from "../prisma";
import { economy } from "./settings.service";

/* ============================================================
   2.4 : le marché des pièces détachées.

   Le pays a un stock de chaque pièce. Chaque pièce commandée (réparation,
   magasin, restauration d'épave) le fait baisser ; il se reconstitue un
   peu chaque heure. Quand il baisse, le prix monte (jusqu'à ×3) et la
   livraison s'allonge (jusqu'à ×2). Une canicule qui casse les bogies de
   tout le monde, et c'est la pénurie.

   Les joueurs peuvent construire une usine de pièces : elle produit un
   type de pièce chaque jour, qu'on range dans son magasin ou qu'on vend
   aux autres au prix qu'on fixe.

   Lecture synchrone pour partPrice() : l'état est gardé en mémoire et relu
   à chaque tour de simulation.
   ============================================================ */

export const MARKET_PARTS = ["FREINS", "BOGIES", "MOTEUR", "CAISSE"] as const;
export type MarketPart = (typeof MARKET_PARTS)[number];

let state = new Map<string, { stock: number; target: number }>();
let pendingUse = new Map<string, number>();

export async function loadPartMarket() {
  const s = economy();
  const rows = (await prisma.partMarket.findMany().catch(() => [])) as { part: string; stock: number; target: number }[];
  const next = new Map<string, { stock: number; target: number }>();
  for (const p of MARKET_PARTS) {
    const r = rows.find((x) => x.part === p);
    next.set(p, r ? { stock: r.stock, target: r.target } : { stock: s.partStock, target: s.partStock });
  }
  state = next;
  return state;
}

/* Tension sur une pièce : 0 quand le stock est plein, 1 quand il est vide. */
export function partScarcity(part: string) {
  const m = state.get(part);
  if (!m || m.target <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - m.stock / m.target));
}

export function partPriceFactor(part: string) {
  const s = economy();
  return 1 + (s.partMaxPriceFactor - 1) * partScarcity(part);
}

export function partDelayFactor(part: string) {
  const s = economy();
  return 1 + (s.partMaxDelayFactor - 1) * partScarcity(part);
}

/* Une pièce sort du stock national (écrit à la fin du tour). */
export function consumePart(part: string, qty = 1) {
  pendingUse.set(part, (pendingUse.get(part) ?? 0) + qty);
  const m = state.get(part);
  if (m) m.stock = Math.max(0, m.stock - qty);
}

export async function flushPartUse() {
  if (pendingUse.size === 0) return;
  const batch = [...pendingUse.entries()];
  pendingUse = new Map();
  const s = economy();
  for (const [part, qty] of batch) {
    await prisma.partMarket
      .upsert({
        where: { part },
        create: { part, stock: Math.max(0, s.partStock - qty), target: s.partStock },
        update: { stock: { decrement: qty } },
      })
      .catch((err: Error) => console.error("[pièces] stock national :", err.message));
  }
  // un stock ne descend pas sous zéro
  await prisma.partMarket.updateMany({ where: { stock: { lt: 0 } }, data: { stock: 0 } }).catch(() => undefined);
}

/* Chaque heure : le stock national se reconstitue, les usines produisent. */
export async function runPartsHourly(now = new Date()) {
  const s = economy();
  for (const p of MARKET_PARTS) {
    const row = await prisma.partMarket.findUnique({ where: { part: p } });
    const target = s.partStock;
    const stock = row?.stock ?? target;
    const next = Math.min(target, stock + Math.ceil(target * s.partRestockPerHour));
    await prisma.partMarket.upsert({ where: { part: p }, create: { part: p, stock: next, target }, update: { stock: next, target } });
  }
  // une usine sort une pièce toutes les 24 h / production journalière
  const every = (24 * 3_600_000) / Math.max(1, s.factoryPerDay);
  const factories = (await prisma.partFactory.findMany({ select: { id: true, stored: true, producedAt: true } })) as { id: string; stored: number; producedAt: Date }[];
  for (const f of factories) {
    const made = Math.floor((now.getTime() - f.producedAt.getTime()) / every);
    if (made <= 0) continue;
    const room = Math.max(0, s.factoryStoreMax - f.stored);
    await prisma.partFactory.update({
      where: { id: f.id },
      data: { stored: f.stored + Math.min(made, room), producedAt: new Date(f.producedAt.getTime() + made * every) },
    });
  }
  await loadPartMarket();
}

export function partMarketView() {
  return MARKET_PARTS.map((p) => {
    const m = state.get(p) ?? { stock: 0, target: 0 };
    return { part: p, stock: m.stock, target: m.target, scarcity: partScarcity(p), priceFactor: partPriceFactor(p), delayFactor: partDelayFactor(p) };
  });
}
