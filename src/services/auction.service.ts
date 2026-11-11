import { prisma } from "../prisma";
import { sendToCompany } from "./push.service";
import { buyoutPayout, buyoutPrice, PROTECTION_MS } from "./infrastructure.service";

/* ============================================================
   2.7 : les enchères de gares (suggestion de DarkLegend).

   Avant, à la fin de la protection d'une gare, le premier clic l'emportait :
   une question de chance plus que de stratégie. Désormais, quand la
   protection tombe, la gare part aux enchères pendant 10 minutes :
   - mise de départ : le prix de rachat habituel ;
   - chaque enchère dépasse la précédente d'au moins 5 % ;
   - la somme est bloquée tout de suite ; un enchérisseur dépassé est
     remboursé aussitôt ;
   - une enchère dans la dernière minute prolonge d'une minute (pas de
     victoire à la dernière seconde) ;
   - le propriétaire touche son dédommagement habituel, augmenté dans la même
     proportion que l'enchère gagnante.
   Sans enchère, la gare reste rachetable au premier venu, comme avant.
   ============================================================ */

export const AUCTION_MINUTES = 10;
export const AUCTION_STEP = 1.05;
const EXTEND_MS = 60_000;
const RECENT_MS = 3600_000; // une protection tombée il y a plus d'une heure n'ouvre plus d'enchères

type Auction = { station: string; ownerId: string; forUntil: Date; minPrice: number; bestBid: number | null; bestId: string | null; endsAt: Date; closedAt: Date | null };

export const nextMinBid = (a: { minPrice: number; bestBid: number | null }) => (a.bestBid ? Math.ceil(a.bestBid * AUCTION_STEP) : a.minPrice);

export async function openAuctions() {
  return (await prisma.stationAuction.findMany({ where: { closedAt: null } })) as Auction[];
}

/* L'enchère en cours pour une gare, si elle bloque le rachat direct. */
export async function auctionFor(station: string) {
  const a = (await prisma.stationAuction.findUnique({ where: { station } })) as Auction | null;
  return a && !a.closedAt ? a : null;
}

/* Le tour régulier : ouvre les enchères des protections qui tombent, clôt celles qui finissent. */
export async function runAuctions(now = new Date()) {
  // 1. ouvrir
  const falling = (await prisma.stationOwnership.findMany({
    where: { protectedUntil: { lte: now, gte: new Date(now.getTime() - RECENT_MS) } },
    select: { station: true, companyId: true, level: true, protectedUntil: true },
  })) as { station: string; companyId: string; level: number; protectedUntil: Date }[];
  if (falling.length) {
    const existing = (await prisma.stationAuction.findMany({ where: { station: { in: falling.map((f) => f.station) } }, select: { station: true, forUntil: true } })) as { station: string; forUntil: Date }[];
    const seen = new Map(existing.map((e) => [e.station, e.forUntil.getTime()]));
    for (const f of falling) {
      if (seen.get(f.station) === f.protectedUntil.getTime()) continue;
      const endsAt = new Date(Math.max(f.protectedUntil.getTime() + AUCTION_MINUTES * 60_000, now.getTime() + 5 * 60_000));
      const data = { ownerId: f.companyId, forUntil: f.protectedUntil, minPrice: buyoutPrice(f), bestBid: null, bestId: null, endsAt, closedAt: null };
      await prisma.stationAuction.upsert({ where: { station: f.station }, create: { station: f.station, ...data }, update: data });
    }
  }
  // 2. clore
  const done = (await prisma.stationAuction.findMany({ where: { closedAt: null, endsAt: { lte: now } } })) as Auction[];
  for (const a of done) {
    const closed = await prisma.stationAuction.updateMany({ where: { station: a.station, closedAt: null }, data: { closedAt: now } });
    if (!closed.count || !a.bestId || !a.bestBid) continue;
    await settle(a, now).catch((e) => console.error("[enchères] clôture :", (e as Error).message));
  }
}

async function refund(companyId: string, amount: number, station: string, why: string) {
  await prisma.$transaction([
    prisma.company.update({ where: { id: companyId }, data: { balance: { increment: amount } } }),
    prisma.transaction.create({ data: { companyId, type: "GARE", amount, description: `${why} : gare de ${station}, enchère remboursée` } }),
  ]);
}

async function settle(a: Auction, now: Date) {
  const own = (await prisma.stationOwnership.findUnique({ where: { station: a.station } })) as { station: string; companyId: string; level: number; invested: number; legacy: boolean } | null;
  // la gare a changé de mains ou a été revendue entre-temps : l'enchère est rendue
  if (!own || own.companyId !== a.ownerId) return refund(a.bestId!, a.bestBid!, a.station, "Enchère annulée");
  const payout = Math.round(buyoutPayout(own) * (a.bestBid! / Math.max(1, a.minPrice)));
  const moved = await prisma.stationOwnership.updateMany({
    where: { station: a.station, companyId: a.ownerId },
    data: { companyId: a.bestId!, invested: a.bestBid!, legacy: false, protectedUntil: new Date(now.getTime() + PROTECTION_MS), boughtAt: now, totalFees: 0, totalShops: 0, protectionNotified: false },
  });
  if (!moved.count) return refund(a.bestId!, a.bestBid!, a.station, "Enchère annulée");
  const [winner, loser] = (await Promise.all([
    prisma.company.findUnique({ where: { id: a.bestId! }, select: { name: true } }),
    prisma.company.findUnique({ where: { id: a.ownerId }, select: { name: true } }),
  ])) as [{ name: string } | null, { name: string } | null];
  await prisma.$transaction([
    prisma.company.update({ where: { id: a.ownerId }, data: { balance: { increment: payout } } }),
    prisma.transaction.create({ data: { companyId: a.ownerId, type: "GARE", amount: payout, description: `Gare de ${a.station} remportée aux enchères par ${winner?.name ?? "une compagnie"}` } }),
  ]);
  void sendToCompany(a.bestId!, { title: `Gare de ${a.station} : à vous`, body: `Vous remportez les enchères pour ${a.bestBid!.toLocaleString("fr-FR")} pi.`, url: "/dashboard", tag: `gare-${a.station}` }).catch(() => {});
  void sendToCompany(a.ownerId, { title: `Gare de ${a.station} vendue aux enchères`, body: `${winner?.name ?? "Une compagnie"} l'emporte : ${payout.toLocaleString("fr-FR")} pi. versées.`, url: "/dashboard", tag: `gare-${a.station}` }).catch(() => {});
  void loser;
}

export type BidResult = { ok: true; amount: number; endsAt: Date } | { ok: false; status: number; error: string };

/* Une enchère. La somme est bloquée ; l'enchérisseur précédent est remboursé. */
export async function placeBid(company: { id: string; name: string }, station: string, amount: number, now = new Date()): Promise<BidResult> {
  const a = await auctionFor(station);
  if (!a || a.endsAt <= now) return { ok: false, status: 409, error: "Pas d'enchères en cours pour cette gare" };
  if (a.ownerId === company.id) return { ok: false, status: 409, error: "C'est votre gare" };
  if (a.bestId === company.id) return { ok: false, status: 409, error: "Vous avez déjà la meilleure enchère" };
  const min = nextMinBid(a);
  if (!Number.isInteger(amount) || amount < min) return { ok: false, status: 400, error: `Enchère minimum : ${min.toLocaleString("fr-FR")} pi.` };
  const paid = await prisma.company.updateMany({ where: { id: company.id, balance: { gte: amount } }, data: { balance: { decrement: amount } } });
  if (!paid.count) return { ok: false, status: 409, error: `Trésorerie insuffisante (${amount.toLocaleString("fr-FR")} pi.)` };
  const endsAt = new Date(Math.max(a.endsAt.getTime(), now.getTime() + EXTEND_MS));
  const took = await prisma.stationAuction.updateMany({
    where: { station, closedAt: null, bestBid: a.bestBid, bestId: a.bestId, endsAt: { gt: now } },
    data: { bestBid: amount, bestId: company.id, endsAt },
  });
  if (!took.count) {
    await prisma.company.update({ where: { id: company.id }, data: { balance: { increment: amount } } });
    return { ok: false, status: 409, error: "Une autre enchère vient d'arriver : la liste est mise à jour" };
  }
  await prisma.transaction.create({ data: { companyId: company.id, type: "GARE", amount: -amount, description: `Enchère : gare de ${station}` } });
  if (a.bestId && a.bestBid) {
    await refund(a.bestId, a.bestBid, station, "Enchère dépassée");
    void sendToCompany(a.bestId, { title: `Gare de ${station} : enchère dépassée`, body: `${company.name} propose ${amount.toLocaleString("fr-FR")} pi. Votre mise vous est rendue.`, url: "/dashboard", tag: `gare-${station}` }).catch(() => {});
  }
  return { ok: true, amount, endsAt };
}
