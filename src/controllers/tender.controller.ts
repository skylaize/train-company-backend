import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { distanceKm, durationBetween } from "../services/geography.service";
import { MIN_BID_RATIO, tripsOnPair, trainsRunningOnPair } from "../services/tender.service";
import { startOfParisWeek, DAY_MS } from "../services/time.service";

/* ============================================================
   Appels d'offres (1.5) — ce que voit le joueur.

   Gratuit : les marchés ouverts, son offre, les résultats, l'avancement de
   son contrat.
   Premium : les marchés de la semaine suivante dès le dimanche (un jour pour
   préparer ses lignes), et le nombre d'offres déjà déposées sur chaque marché
   — jamais leur montant.
   ============================================================ */

async function myCompany(req: AuthRequest) {
  return prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true, isPremium: true, balance: true },
  });
}

export async function listTenders(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const now = new Date();
  const week = startOfParisWeek(now);
  const tenders = (await prisma.tender.findMany({
    where: { weekStart: { gte: new Date(week.getTime() - 15 * DAY_MS) } },
    orderBy: [{ weekStart: "desc" }, { region: "asc" }],
    include: { bids: { select: { companyId: true, amount: true } } },
  })) as any[];

  const winnerIds = [...new Set(tenders.map((t) => t.winnerId).filter(Boolean))] as string[];
  const winners = (await prisma.company.findMany({
    where: { id: { in: winnerIds } },
    select: { id: true, name: true, emblem: true, liveryColor: true },
  })) as { id: string; name: string; emblem: string | null; liveryColor: string }[];
  const winnerById = new Map(winners.map((w) => [w.id, w]));

  const myLines = (await prisma.line.findMany({
    where: { companyId: company.id },
    select: { departureStation: true, arrivalStation: true },
  })) as { departureStation: string; arrivalStation: string }[];
  const hasLine = (a: string, b: string) =>
    myLines.some((l) => (l.departureStation === a && l.arrivalStation === b) || (l.departureStation === b && l.arrivalStation === a));

  const out = [];
  for (const t of tenders) {
    // un marché annoncé n'est visible que des abonnés
    if (t.status === "ANNONCE" && (!company.isPremium || t.publishedAt > now)) continue;
    const mine = t.bids.find((b: any) => b.companyId === company.id);
    const winner = t.winnerId ? winnerById.get(t.winnerId) : null;
    const isMe = t.winnerId === company.id;
    let progress = null;
    if (isMe && t.status === "ATTRIBUE") {
      progress = {
        trips: await tripsOnPair(company.id, t.stationA, t.stationB, t.closesAt, now),
        paidTotal: t.paidTotal,
        running: (await trainsRunningOnPair(company.id, t.stationA, t.stationB)).running > 0,
      };
    }
    out.push({
      id: t.id,
      weekStart: t.weekStart,
      region: t.region,
      stationA: t.stationA,
      stationB: t.stationB,
      km: distanceKm(t.stationA, t.stationB),
      durationMinutes: durationBetween(t.stationA, t.stationB),
      budgetPerDay: t.budgetPerDay,
      minBid: Math.ceil(t.budgetPerDay * MIN_BID_RATIO),
      tripsRequired: t.tripsRequired,
      publishedAt: t.publishedAt,
      opensAt: t.opensAt,
      closesAt: t.closesAt,
      endsAt: t.endsAt,
      status: t.status,
      myBid: mine ? mine.amount : null,
      bidCount: company.isPremium && (t.status === "OUVERT" || t.status === "ANNONCE") ? t.bids.length : null,
      totalBids: t.status === "OUVERT" || t.status === "ANNONCE" ? null : t.bids.length,
      hasLine: hasLine(t.stationA, t.stationB),
      winner: winner ? { name: winner.name, emblem: winner.emblem, liveryColor: winner.liveryColor, isMe } : null,
      winningBid: t.winningBid,
      progress,
      trips: t.status === "TERMINE" ? t.trips : null,
      objectiveMet: t.objectiveMet,
      paidTotal: isMe ? t.paidTotal : null,
    });
  }

  return res.json({
    isPremium: company.isPremium,
    now,
    tenders: out,
    // de quoi annoncer au joueur gratuit qu'une nouvelle série est déjà connue
    announcedCount: company.isPremium ? 0 : tenders.filter((t) => t.status === "ANNONCE" && t.publishedAt <= now).length,
  });
}

export async function placeBid(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const tender = await prisma.tender.findUnique({ where: { id: String(req.params.id) } });
  if (!tender) return res.status(404).json({ error: "Appel d'offres introuvable" });
  if (tender.status !== "OUVERT" || tender.closesAt <= new Date()) {
    return res.status(400).json({ error: "Les offres ne sont pas ouvertes sur ce marché" });
  }

  const amount = Math.round(Number(req.body?.amount));
  const min = Math.ceil(tender.budgetPerDay * MIN_BID_RATIO);
  if (!Number.isFinite(amount) || amount < min || amount > tender.budgetPerDay) {
    return res.status(400).json({ error: `L'offre doit être comprise entre ${min} et ${tender.budgetPerDay} pi. par jour` });
  }

  /* il faut exploiter la liaison pour y prétendre : on ne remporte pas un
     marché juste pour le bloquer aux autres */
  const onPair = await prisma.line.count({
    where: {
      companyId: company.id,
      OR: [
        { departureStation: tender.stationA, arrivalStation: tender.stationB },
        { departureStation: tender.stationB, arrivalStation: tender.stationA },
      ],
    },
  });
  if (onPair === 0) {
    return res.status(400).json({ error: `Ouvrez d'abord une ligne ${tender.stationA} – ${tender.stationB} pour soumissionner` });
  }

  // une offre modifiée compte comme déposée maintenant pour départager les égalités
  const bid = await prisma.tenderBid.upsert({
    where: { tenderId_companyId: { tenderId: tender.id, companyId: company.id } },
    create: { tenderId: tender.id, companyId: company.id, amount },
    update: { amount, createdAt: new Date() },
  });
  return res.json({ ok: true, amount: bid.amount });
}

export async function withdrawBid(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const tender = await prisma.tender.findUnique({ where: { id: String(req.params.id) } });
  if (!tender || tender.status !== "OUVERT" || tender.closesAt <= new Date()) return res.status(400).json({ error: "Cette offre ne peut plus être retirée" });

  await prisma.tenderBid.deleteMany({ where: { tenderId: tender.id, companyId: company.id } });
  return res.json({ ok: true });
}
