import { Response } from "express";
import { prisma } from "../prisma";
import { AuthRequest } from "../middleware/auth.middleware";
import {
  LOAN_TERMS,
  LOAN_AMOUNTS,
  MAX_OPEN_LOANS,
  riskPremium,
  installmentOf,
  payoffOf,
  loanCapacity,
  computeReputation,
  weeklyReport,
  SHARES_PER_COMPANY,
  MAX_HOLD,
  MAX_FLOAT,
  TRADE_FEE,
  LISTING_MIN_AGE_MS,
  DIVIDEND_RATE,
  DIVIDEND_HOUR,
  heldByIssuer,
  marketPrice,
  buyCost,
  sellProceeds,
  executeTrade,
  MAX_ORDERS,
  reportHistory,
} from "../services/finance.service";

type Co = { id: string; name: string; balance: number; createdAt: Date; sharePrice: number; isPremium: boolean };

async function companyOf(req: AuthRequest) {
  return prisma.company.findUnique({ where: { ownerId: req.userId as string } }) as Promise<Co | null>;
}

/* ---------------- banque ---------------- */

export async function getLoans(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const [loans, capacity, reputation] = await Promise.all([
    prisma.loan.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" }, take: 10 }) as Promise<
      { id: string; principal: number; ratePct: number; totalDue: number; remaining: number; hours: number; missed: number; createdAt: Date; lastPaidAt: Date; closedAt: Date | null }[]
    >,
    loanCapacity(company.id),
    computeReputation(company.id),
  ]);
  const premium = riskPremium(reputation);
  return res.json({
    capacity,
    reputation,
    riskPremium: premium,
    maxOpen: MAX_OPEN_LOANS,
    offers: LOAN_TERMS.map((t) => ({ ...t, ratePct: Math.round((t.ratePct + premium) * 10) / 10 })),
    amounts: LOAN_AMOUNTS,
    loans: loans.map((l) => ({
      ...l,
      installment: installmentOf(l),
      payoff: l.closedAt ? 0 : payoffOf(l),
      hoursLeft: l.closedAt ? 0 : Math.ceil(l.remaining / installmentOf(l)),
    })),
  });
}

export async function takeLoan(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const amount = Number(req.body?.amount);
  const term = LOAN_TERMS.find((t) => t.hours === Number(req.body?.hours));
  if (!LOAN_AMOUNTS.includes(amount) || !term) return res.status(400).json({ error: "Montant ou durée invalide" });
  const cap = await loanCapacity(company.id);
  if (cap.open >= MAX_OPEN_LOANS) return res.status(409).json({ error: `${MAX_OPEN_LOANS} emprunts en cours au plus` });
  if (cap.late) return res.status(409).json({ error: "La banque refuse : une échéance est restée impayée" });
  if (amount > cap.available) return res.status(409).json({ error: `La banque ne vous prête pas plus de ${cap.available.toLocaleString("fr-FR")} pi. aujourd'hui` });
  const ratePct = Math.round((term.ratePct + riskPremium(await computeReputation(company.id))) * 10) / 10;
  const totalDue = Math.round(amount * (1 + ratePct / 100));
  await prisma.$transaction([
    prisma.loan.create({ data: { companyId: company.id, principal: amount, ratePct, totalDue, remaining: totalDue, hours: term.hours } }),
    prisma.company.update({ where: { id: company.id }, data: { balance: { increment: amount } } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "EMPRUNT", amount, description: `Emprunt de ${amount.toLocaleString("fr-FR")} pi. sur ${term.label} (${String(ratePct).replace(".", ",")} %)` } }),
  ]);
  return res.json({ ok: true, totalDue });
}

export async function repayLoan(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const loan = (await prisma.loan.findFirst({ where: { id: req.body?.loanId, companyId: company.id, closedAt: null } })) as
    | { id: string; remaining: number; totalDue: number; principal: number }
    | null;
  if (!loan) return res.status(404).json({ error: "Emprunt introuvable ou déjà soldé" });
  const payoff = payoffOf(loan);
  const done = await prisma.company.updateMany({ where: { id: company.id, balance: { gte: payoff } }, data: { balance: { decrement: payoff } } });
  if (done.count === 0) return res.status(409).json({ error: `Trésorerie insuffisante (${payoff.toLocaleString("fr-FR")} pi.)` });
  await prisma.$transaction([
    prisma.loan.update({ where: { id: loan.id }, data: { remaining: 0, closedAt: new Date() } }),
    prisma.transaction.create({ data: { companyId: company.id, type: "REMBOURSEMENT", amount: -payoff, description: "Remboursement anticipé d'emprunt" } }),
  ]);
  return res.json({ ok: true, payoff });
}

/* ---------------- rapport de la semaine ---------------- */

export async function getWeeklyReport(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const offset = Math.min(8, Math.max(0, Number(req.query.week) || 0));
  return res.json(await weeklyReport(company.id, offset));
}

/* ---------------- bourse ---------------- */

export async function getMarket(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const minCreated = new Date(Date.now() - LISTING_MIN_AGE_MS);
  const [listed, held, mine, history] = (await Promise.all([
    prisma.company.findMany({
      where: { createdAt: { lte: minCreated }, sharePrice: { gt: 0 }, lines: { some: {} } },
      select: { id: true, name: true, emblem: true, liveryColor: true, sharePrice: true },
      orderBy: { sharePrice: "desc" },
      take: 60,
    }),
    heldByIssuer(),
    prisma.shareholding.findMany({ where: { holderId: company.id } }),
    prisma.sharePrice.findMany({ where: { at: { gte: new Date(Date.now() - 7 * 86_400_000) } }, orderBy: { at: "asc" }, select: { companyId: true, price: true, at: true } }),
  ])) as [
    { id: string; name: string; emblem: string | null; liveryColor: string; sharePrice: number }[],
    Map<string, number>,
    { issuerId: string; shares: number; invested: number }[],
    { companyId: string; price: number; at: Date }[]
  ];
  const hist = new Map<string, number[]>();
  for (const h of history) {
    const a = hist.get(h.companyId) ?? [];
    a.push(h.price);
    hist.set(h.companyId, a);
  }
  const mineBy = new Map(mine.map((m) => [m.issuerId, m]));
  const since24 = new Date(Date.now() - 86_400_000);
  const revenue = (await prisma.transaction.groupBy({
    by: ["companyId"],
    where: { type: "REVENU_LIGNE", createdAt: { gte: since24 }, companyId: { in: listed.map((c) => c.id) } },
    _sum: { amount: true },
  })) as { companyId: string; _sum: { amount: number | null } }[];
  const rev = new Map(revenue.map((r) => [r.companyId, r._sum.amount ?? 0]));

  const row = (c: { id: string; name: string; emblem: string | null; liveryColor: string; sharePrice: number }) => {
    const h = held.get(c.id) ?? 0;
    const price = marketPrice(c.sharePrice, h);
    const series = hist.get(c.id) ?? [];
    // variation sur 24 h : 24 relevés horaires plus tôt, ou le plus ancien disponible
    const ref = series.length > 1 ? series[Math.max(0, series.length - 25)] : price;
    const m = mineBy.get(c.id);
    const dps = ((rev.get(c.id) ?? 0) * DIVIDEND_RATE) / SHARES_PER_COMPANY;
    return {
      id: c.id,
      name: c.name,
      emblem: c.emblem,
      liveryColor: c.liveryColor,
      isMe: c.id === company.id,
      price: Math.round(price * 100) / 100,
      change24h: ref > 0 ? Math.round(((price - ref) / ref) * 1000) / 10 : 0,
      held: h,
      dividendPerShare: Math.round(dps * 100) / 100,
      yieldPct: price > 0 ? Math.round((dps / price) * 1000) / 10 : 0,
      history: series.slice(-72),
      mine: m ? { shares: m.shares, invested: m.invested, value: sellProceeds(c.sharePrice, h, m.shares) } : null,
      buyOne: buyCost(c.sharePrice, h, 1),
    };
  };

  // ma compagnie est cotée elle aussi : on veut voir son propre cours, même sans pouvoir acheter
  const me = listed.find((c) => c.id === company.id);
  // Premium : qui détient mes actions, et mes ordres en attente
  const [holders, orders] = company.isPremium
    ? ((await Promise.all([
        prisma.shareholding.findMany({ where: { issuerId: company.id }, select: { shares: true, holder: { select: { name: true, emblem: true, liveryColor: true } } }, orderBy: { shares: "desc" } }),
        prisma.stockOrder.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "asc" } }),
      ])) as [
        { shares: number; holder: { name: string; emblem: string | null; liveryColor: string } | null }[],
        { id: string; issuerId: string; side: string; shares: number; limitPrice: number; createdAt: Date }[]
      ])
    : [null, null];
  const names = new Map(listed.map((c) => [c.id, c.name]));
  return res.json({
    rules: { shares: SHARES_PER_COMPANY, maxHold: MAX_HOLD, maxFloat: MAX_FLOAT, fee: TRADE_FEE, dividendRate: DIVIDEND_RATE, dividendHour: DIVIDEND_HOUR, listingDays: LISTING_MIN_AGE_MS / 86_400_000 },
    me: me ? row(me) : { id: company.id, name: company.name, listed: false, price: company.sharePrice },
    companies: listed.filter((c) => c.id !== company.id).map(row),
    portfolio: mine.length,
    isPremium: company.isPremium,
    maxOrders: MAX_ORDERS,
    shareholders: holders ? holders.map((h) => ({ name: h.holder?.name ?? "—", emblem: h.holder?.emblem ?? null, liveryColor: h.holder?.liveryColor ?? "#888", shares: h.shares })) : null,
    orders: orders ? orders.map((o) => ({ ...o, issuerName: names.get(o.issuerId) ?? "—" })) : null,
  });
}

export async function buyShares(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const r = await executeTrade(company.id, String(req.body?.issuerId ?? ""), "BUY", Math.floor(Number(req.body?.shares)));
  return r.ok ? res.json(r) : res.status(r.status).json({ error: r.error });
}

export async function sellShares(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const r = await executeTrade(company.id, String(req.body?.issuerId ?? ""), "SELL", Math.floor(Number(req.body?.shares)));
  return r.ok ? res.json(r) : res.status(r.status).json({ error: r.error });
}

/* ---------------- Premium : ordres à cours limite ---------------- */

export async function createOrder(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  if (!company.isPremium) return res.status(403).json({ error: "Les ordres automatiques sont réservés aux abonnés Premium" });
  const side = req.body?.side === "SELL" ? "SELL" : req.body?.side === "BUY" ? "BUY" : null;
  const shares = Math.floor(Number(req.body?.shares));
  const limitPrice = Math.round(Number(req.body?.limitPrice) * 100) / 100;
  const issuerId = String(req.body?.issuerId ?? "");
  if (!side || !(shares >= 1 && shares <= MAX_HOLD) || !(limitPrice > 0)) return res.status(400).json({ error: "Ordre invalide" });
  if (issuerId === company.id) return res.status(409).json({ error: "On n'achète pas ses propres actions" });
  const issuer = await prisma.company.findUnique({ where: { id: issuerId }, select: { id: true } });
  if (!issuer) return res.status(404).json({ error: "Compagnie introuvable" });
  const count = await prisma.stockOrder.count({ where: { companyId: company.id } });
  if (count >= MAX_ORDERS) return res.status(409).json({ error: `${MAX_ORDERS} ordres en attente au plus` });
  const order = await prisma.stockOrder.create({ data: { companyId: company.id, issuerId, side, shares, limitPrice } });
  return res.json(order);
}

export async function cancelOrder(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const gone = await prisma.stockOrder.deleteMany({ where: { id: String(req.params.id), companyId: company.id } });
  return gone.count ? res.json({ ok: true }) : res.status(404).json({ error: "Ordre introuvable" });
}

/* ---------------- Premium : rapport sur quatre semaines ---------------- */

export async function getReportHistory(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  if (!company.isPremium) return res.status(403).json({ error: "Réservé aux abonnés Premium" });
  return res.json({ weeks: await reportHistory(company.id, 4) });
}
