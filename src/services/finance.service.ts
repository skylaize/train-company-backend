import { prisma } from "../prisma";
import { buildLeaderRows } from "./leaderboard.service";
import { computeReputation } from "./reputation.service";
import { parisDate, parisHour, parisMidnight, startOfParisWeek, DAY_MS } from "./time.service";

/* ============================================================
   Finances (1.7) : banque, bourse, rapport de la semaine.
   ============================================================ */

type Notify = (companyId: string, title: string, body: string) => Promise<void>;
const HOUR_MS = 3600_000;

/* ---------------- banque ---------------- */

// durée (heures) et intérêt total sur la durée, avant la prime de risque
export const LOAN_TERMS = [
  { hours: 24, ratePct: 3, label: "1 jour" },
  { hours: 72, ratePct: 7, label: "3 jours" },
  { hours: 168, ratePct: 12, label: "7 jours" },
];
export const LOAN_AMOUNTS = [2000, 5000, 10000, 25000, 50000];
export const MAX_OPEN_LOANS = 2;
export const LOAN_CAP_RATIO = 0.5; // on n'emprunte pas plus de la moitié de ce que vaut la compagnie
export const LATE_PENALTY = 0.05; // échéance impayée : +5 % de l'échéance sur le reste dû
export const EARLY_DISCOUNT = 0.5; // remboursement anticipé : la moitié des intérêts restants est effacée

// une compagnie mal notée paie plus cher : jusqu'à +5 points sous 90 % de réputation
export function riskPremium(reputation: number) {
  return Math.min(5, Math.max(0, (90 - reputation) / 10));
}

export function installmentOf(loan: { totalDue: number; hours: number }) {
  return Math.ceil(loan.totalDue / loan.hours);
}

export function payoffOf(loan: { remaining: number; totalDue: number; principal: number }) {
  const interestLeft = (loan.remaining * (loan.totalDue - loan.principal)) / loan.totalDue;
  return loan.remaining - Math.floor(interestLeft * EARLY_DISCOUNT);
}

/* Ce que la banque accepte de prêter : la valeur de la compagnie hors dettes,
   dont on retire ce qu'elle doit déjà. */
export async function loanCapacity(companyId: string) {
  const row = (await buildLeaderRows()).find((r) => r.id === companyId);
  const open = (await prisma.loan.findMany({ where: { companyId, closedAt: null } })) as { remaining: number; missed: number }[];
  const debt = open.reduce((a, l) => a + l.remaining, 0);
  const grossValue = (row?.valeur ?? 0) + debt; // valeur « hors dettes »
  const cap = Math.max(2000, Math.round(grossValue * LOAN_CAP_RATIO));
  return { cap, debt, available: Math.max(0, cap - debt), open: open.length, late: open.some((l) => l.missed > 0) };
}

/* Échéances horaires. Une échéance impayée n'est pas prélevée de force : elle
   alourdit la dette et coûte un point de réputation. */
export async function runLoanPayments(notify?: Notify) {
  const now = Date.now();
  const due = (await prisma.loan.findMany({
    where: { closedAt: null, lastPaidAt: { lte: new Date(now - HOUR_MS) } },
    take: 500,
  })) as { id: string; companyId: string; remaining: number; totalDue: number; hours: number; missed: number; lastPaidAt: Date }[];

  for (const loan of due) {
    const pay = Math.min(installmentOf(loan), loan.remaining);
    const nextPaid = new Date(new Date(loan.lastPaidAt).getTime() + HOUR_MS);
    const debited = await prisma.company.updateMany({
      where: { id: loan.companyId, balance: { gte: pay } },
      data: { balance: { decrement: pay } },
    });
    if (debited.count > 0) {
      const left = loan.remaining - pay;
      await prisma.$transaction([
        prisma.loan.update({ where: { id: loan.id }, data: { remaining: left, lastPaidAt: nextPaid, ...(left <= 0 ? { closedAt: new Date() } : {}) } }),
        prisma.transaction.create({
          data: { companyId: loan.companyId, type: "REMBOURSEMENT", amount: -pay, description: left <= 0 ? "Emprunt soldé : dernière échéance" : "Échéance d'emprunt" },
        }),
      ]);
      if (left <= 0) await notify?.(loan.companyId, "Emprunt remboursé", "La banque vous remercie : votre emprunt est soldé.").catch(() => {});
    } else {
      const penalty = Math.ceil(pay * LATE_PENALTY);
      await prisma.$transaction([
        prisma.loan.update({ where: { id: loan.id }, data: { remaining: { increment: penalty }, totalDue: { increment: penalty }, missed: { increment: 1 }, lastPaidAt: nextPaid } }),
        prisma.company.update({ where: { id: loan.companyId }, data: { reputationAdjust: { decrement: 1 } } }),
      ]);
      if (loan.missed === 0) {
        await notify?.(loan.companyId, "Échéance impayée", `Trésorerie insuffisante pour l'échéance de ${pay} pi. : pénalité de ${penalty} pi. et un point de réputation perdu.`).catch(() => {});
      }
    }
  }
}

/* ---------------- bourse ---------------- */

export const SHARES_PER_COMPANY = 1000;
export const MAX_HOLD = 100; // 10 % d'une compagnie par actionnaire
export const MAX_FLOAT = 490; // la compagnie garde toujours la majorité
export const DEMAND_PREMIUM = 0.4; // le cours monte de 40 % quand tout le flottant est détenu
export const TRADE_FEE = 0.01;
export const LISTING_MIN_AGE_MS = 2 * DAY_MS;
export const DIVIDEND_RATE = 0.03; // 3 % des recettes de ligne des dernières 24 h, répartis sur 1000 actions
export const DIVIDEND_HOUR = 20; // versés chaque soir à 20 h

/* Cours de référence : valeur de la compagnie plus une journée de recettes,
   divisée en 1000 actions. La demande des autres joueurs s'y ajoute. */
export async function runSharePrices() {
  const rows = await buildLeaderRows();
  const since = new Date(Date.now() - DAY_MS);
  const revenue = (await prisma.transaction.groupBy({
    by: ["companyId"],
    where: { type: "REVENU_LIGNE", createdAt: { gte: since } },
    _sum: { amount: true },
  })) as { companyId: string; _sum: { amount: number | null } }[];
  const rev = new Map(revenue.map((r) => [r.companyId, r._sum.amount ?? 0]));
  const held = await heldByIssuer();
  for (const r of rows) {
    const fundamental = Math.max(1, (Math.max(0, r.valeur) + (rev.get(r.id) ?? 0)) / SHARES_PER_COMPANY);
    const price = Math.round(fundamental * 100) / 100;
    await prisma.company.update({ where: { id: r.id }, data: { sharePrice: price } });
    await prisma.sharePrice.create({ data: { companyId: r.id, price: Math.round(marketPrice(price, held.get(r.id) ?? 0) * 100) / 100 } });
  }
  // une semaine d'historique suffit à tracer les courbes
  await prisma.sharePrice.deleteMany({ where: { at: { lt: new Date(Date.now() - 8 * DAY_MS) } } });
}

export async function heldByIssuer() {
  const rows = (await prisma.shareholding.groupBy({ by: ["issuerId"], _sum: { shares: true } })) as { issuerId: string; _sum: { shares: number | null } }[];
  return new Map(rows.map((r) => [r.issuerId, r._sum.shares ?? 0]));
}

export function marketPrice(fundamental: number, held: number) {
  return fundamental * (1 + (DEMAND_PREMIUM * held) / SHARES_PER_COMPANY);
}

// prix moyen payé pour `n` actions : le cours monte au fil de l'achat
export function buyCost(fundamental: number, held: number, n: number) {
  return Math.ceil(n * marketPrice(fundamental, held + n / 2) * (1 + TRADE_FEE));
}
export function sellProceeds(fundamental: number, held: number, n: number) {
  return Math.floor(n * marketPrice(fundamental, held - n / 2) * (1 - TRADE_FEE));
}

export async function runDividends() {
  const now = new Date();
  if (parisHour(now) !== DIVIDEND_HOUR) return;
  const d = parisDate(now);
  const today = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  const issuers = (await prisma.company.findMany({
    where: { shareholders: { some: {} }, OR: [{ lastDividendOn: null }, { lastDividendOn: { not: today } }] },
    select: { id: true, name: true },
    take: 200,
  })) as { id: string; name: string }[];
  for (const issuer of issuers) {
    await prisma.company.update({ where: { id: issuer.id }, data: { lastDividendOn: today } });
    const agg = (await prisma.transaction.aggregate({
      where: { companyId: issuer.id, type: "REVENU_LIGNE", createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
      _sum: { amount: true },
    })) as { _sum: { amount: number | null } };
    const perShare = ((agg._sum.amount ?? 0) * DIVIDEND_RATE) / SHARES_PER_COMPANY;
    if (perShare <= 0) continue;
    const holders = (await prisma.shareholding.findMany({ where: { issuerId: issuer.id } })) as { holderId: string; shares: number }[];
    for (const h of holders) {
      const amount = Math.floor(h.shares * perShare);
      if (amount <= 0) continue;
      await prisma.$transaction([
        prisma.company.update({ where: { id: h.holderId }, data: { balance: { increment: amount } } }),
        prisma.transaction.create({ data: { companyId: h.holderId, type: "DIVIDENDE", amount, description: `Dividendes : ${h.shares} actions ${issuer.name}` } }),
      ]);
    }
  }
}

/* ---------------- rapport de la semaine ---------------- */

const INCOME_GROUPS: Record<string, string> = {
  REVENU_LIGNE: "Recettes voyageurs",
  FRET: "Fret",
  VENTE_FRET: "Fret",
  SUBVENTION: "Appels d'offres",
  REDEVANCE_QUAI: "Gares",
  COMMERCES: "Gares",
  DIVIDENDE: "Bourse",
  BOURSE: "Bourse",
  MISSION: "Missions",
  DEFI_QUOTIDIEN: "Bonus",
  PARRAINAGE: "Bonus",
  PUBLICITE: "Bonus",
  COMPENSATION: "Bonus",
  EMPRUNT: "Banque",
};
const EXPENSE_GROUPS: Record<string, string> = {
  ENTRETIEN: "Entretien",
  PERSONNEL: "Personnel",
  REPARATION: "Réparations",
  PEAGE: "Péages et redevances",
  REDEVANCE_QUAI: "Péages et redevances",
  ACHAT_TRAIN: "Investissements",
  COMPOSITION: "Investissements",
  EXPANSION_FLOTTE: "Investissements",
  CHANTIER: "Investissements",
  ELECTRIFICATION: "Investissements",
  GARE: "Investissements",
  ATELIER: "Investissements",
  LICENCE: "Investissements",
  REMBOURSEMENT: "Banque",
  BOURSE: "Bourse",
  ACHAT_FRET: "Fret",
  GARDE: "Fret",
};

export function weekBounds(offset: number, now = new Date()) {
  const start = new Date(startOfParisWeek(now).getTime() - offset * 7 * DAY_MS);
  const d = parisDate(new Date(start.getTime() + 12 * HOUR_MS));
  const end = parisMidnight(d.year, d.month, d.day + 7);
  return { start, end: offset === 0 ? now : end };
}

export async function weeklyReport(companyId: string, offset = 0) {
  const { start, end } = weekBounds(offset);
  const prev = weekBounds(offset + 1);
  const [byType, prevByType, byLine, trips, incidents, lines] = (await Promise.all([
    prisma.transaction.groupBy({ by: ["type"], where: { companyId, createdAt: { gte: start, lt: end } }, _sum: { amount: true } }),
    prisma.transaction.groupBy({ by: ["type"], where: { companyId, createdAt: { gte: prev.start, lt: prev.end } }, _sum: { amount: true } }),
    prisma.transaction.groupBy({ by: ["lineId"], where: { companyId, type: "REVENU_LIGNE", createdAt: { gte: start, lt: end } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.transaction.count({ where: { companyId, type: "REVENU_LIGNE", createdAt: { gte: start, lt: end } } }),
    prisma.incident.count({ where: { train: { companyId }, createdAt: { gte: start, lt: end } } }),
    prisma.line.findMany({ where: { companyId }, select: { id: true, departureStation: true, arrivalStation: true } }),
  ])) as [
    { type: string; _sum: { amount: number | null } }[],
    { type: string; _sum: { amount: number | null } }[],
    { lineId: string | null; _sum: { amount: number | null }; _count: { _all: number } }[],
    number,
    number,
    { id: string; departureStation: string; arrivalStation: string }[]
  ];

  const income = new Map<string, number>();
  const expenses = new Map<string, number>();
  let net = 0;
  for (const r of byType) {
    const v = r._sum.amount ?? 0;
    net += v;
    if (v >= 0) income.set(INCOME_GROUPS[r.type] ?? "Divers", (income.get(INCOME_GROUPS[r.type] ?? "Divers") ?? 0) + v);
    else expenses.set(EXPENSE_GROUPS[r.type] ?? "Divers", (expenses.get(EXPENSE_GROUPS[r.type] ?? "Divers") ?? 0) - v);
  }
  const prevNet = prevByType.reduce((a, r) => a + (r._sum.amount ?? 0), 0);
  // l'exploitation seule : sans investissements, emprunts ni bourse, pour juger la santé du réseau
  const OPERATING_OUT = new Set(["ACHAT_TRAIN", "COMPOSITION", "EXPANSION_FLOTTE", "CHANTIER", "ELECTRIFICATION", "GARE", "ATELIER", "LICENCE", "EMPRUNT", "REMBOURSEMENT", "BOURSE", "FONDATION"]);
  const operating = byType.filter((r) => !OPERATING_OUT.has(r.type)).reduce((a, r) => a + (r._sum.amount ?? 0), 0);
  const prevOperating = prevByType.filter((r) => !OPERATING_OUT.has(r.type)).reduce((a, r) => a + (r._sum.amount ?? 0), 0);
  const names = new Map(lines.map((l) => [l.id, `${l.departureStation} ⇄ ${l.arrivalStation}`]));
  const sorted = (m: Map<string, number>) => [...m.entries()].map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);

  return {
    from: start,
    to: end,
    current: offset === 0,
    net,
    prevNet,
    operating,
    prevOperating,
    income: sorted(income),
    expenses: sorted(expenses),
    trips,
    incidents,
    lines: byLine
      .filter((l) => l.lineId && names.has(l.lineId))
      .map((l) => ({ lineId: l.lineId, name: names.get(l.lineId as string), revenue: l._sum.amount ?? 0, trips: l._count._all }))
      .sort((a, b) => b.revenue - a.revenue),
  };
}

/* Le lundi matin, chaque joueur abonné aux notifications reçoit le résumé de sa semaine. */
export async function runWeeklyReports(notify?: Notify) {
  const now = new Date();
  const d = parisDate(now);
  if (d.weekday !== 0 || parisHour(now) < 9 || parisHour(now) >= 12) return;
  const monday = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  const companies = (await prisma.company.findMany({
    where: { pushSubscriptions: { some: {} }, OR: [{ lastWeeklyReport: null }, { lastWeeklyReport: { not: monday } }] },
    select: { id: true },
    take: 100,
  })) as { id: string }[];
  for (const c of companies) {
    await prisma.company.update({ where: { id: c.id }, data: { lastWeeklyReport: monday } });
    const r = await weeklyReport(c.id, 1);
    if (r.trips === 0 && r.net === 0) continue;
    const sign = r.operating >= 0 ? "+" : "";
    const trend = r.prevOperating ? ` (${r.operating >= r.prevOperating ? "en hausse" : "en baisse"} sur la semaine d'avant)` : "";
    await notify?.(c.id, "Votre rapport de la semaine", `Exploitation : ${sign}${r.operating.toLocaleString("fr-FR")} pi.${trend}, ${r.trips} trajets.`).catch(() => {});
  }
}

export { computeReputation };

/* ---------------- ordres de bourse (1.7) ---------------- */

export type TradeResult = { ok: true; cost?: number; proceeds?: number; gain?: number } | { ok: false; status: number; error: string; retry?: boolean };

/* Achat ou vente au cours du moment. Utilisé par les boutons de la bourse et
   par les ordres automatiques des abonnés : mêmes règles, mêmes plafonds. */
export async function executeTrade(holderId: string, issuerId: string, side: "BUY" | "SELL", n: number): Promise<TradeResult> {
  if (!Number.isFinite(n) || n < 1 || n > MAX_HOLD) return { ok: false, status: 400, error: "Nombre d'actions invalide" };
  const issuer = (await prisma.company.findUnique({ where: { id: issuerId }, select: { id: true, name: true, sharePrice: true, createdAt: true } })) as
    | { id: string; name: string; sharePrice: number; createdAt: Date }
    | null;
  if (!issuer || issuer.sharePrice <= 0) return { ok: false, status: 404, error: "Compagnie non cotée" };
  if (issuer.id === holderId) return { ok: false, status: 409, error: "On n'achète pas ses propres actions" };
  const held = (await heldByIssuer()).get(issuer.id) ?? 0;
  const mine = (await prisma.shareholding.findUnique({ where: { holderId_issuerId: { holderId, issuerId: issuer.id } } })) as
    | { id: string; shares: number; invested: number }
    | null;

  if (side === "BUY") {
    if (Date.now() - new Date(issuer.createdAt).getTime() < LISTING_MIN_AGE_MS) return { ok: false, status: 409, error: "Compagnie trop récente pour être cotée" };
    if ((mine?.shares ?? 0) + n > MAX_HOLD) return { ok: false, status: 409, error: `${MAX_HOLD} actions au plus par compagnie (10 %)` };
    if (held + n > MAX_FLOAT) return { ok: false, status: 409, error: `Plus que ${Math.max(0, MAX_FLOAT - held)} actions disponibles sur le marché`, retry: true };
    const cost = buyCost(issuer.sharePrice, held, n);
    const done = await prisma.company.updateMany({ where: { id: holderId, balance: { gte: cost } }, data: { balance: { decrement: cost } } });
    if (done.count === 0) return { ok: false, status: 409, error: `Trésorerie insuffisante (${cost.toLocaleString("fr-FR")} pi.)`, retry: true };
    await prisma.$transaction([
      prisma.shareholding.upsert({
        where: { holderId_issuerId: { holderId, issuerId: issuer.id } },
        create: { holderId, issuerId: issuer.id, shares: n, invested: cost },
        update: { shares: { increment: n }, invested: { increment: cost } },
      }),
      prisma.transaction.create({ data: { companyId: holderId, type: "BOURSE", amount: -cost, description: `Achat de ${n} action${n > 1 ? "s" : ""} ${issuer.name}` } }),
    ]);
    return { ok: true, cost };
  }

  if (!mine || n > mine.shares) return { ok: false, status: 400, error: "Vous n'avez pas autant d'actions" };
  const proceeds = sellProceeds(issuer.sharePrice, held, n);
  const investedPart = Math.round((mine.invested * n) / mine.shares);
  // la ligne ne bouge que si elle n'a pas changé entre-temps : pas de double vente
  const updated = await prisma.shareholding.updateMany({
    where: { id: mine.id, shares: mine.shares },
    data: { shares: { decrement: n }, invested: { decrement: investedPart } },
  });
  if (updated.count === 0) return { ok: false, status: 409, error: "Opération en cours, réessayez", retry: true };
  await prisma.$transaction([
    ...(n === mine.shares ? [prisma.shareholding.delete({ where: { id: mine.id } })] : []),
    prisma.company.update({ where: { id: holderId }, data: { balance: { increment: proceeds } } }),
    prisma.transaction.create({ data: { companyId: holderId, type: "BOURSE", amount: proceeds, description: `Vente de ${n} action${n > 1 ? "s" : ""} ${issuer.name}` } }),
  ]);
  return { ok: true, proceeds, gain: proceeds - investedPart };
}

export const MAX_ORDERS = 5;

/* Ordres à cours limite des abonnés : achat quand le cours descend sous la
   limite, vente quand il la dépasse. Un ordre qui ne peut plus passer (plafond
   atteint, actions vendues entre-temps) est annulé ; un ordre bloqué par la
   trésorerie attend. */
export async function runStockOrders(notify?: Notify) {
  const orders = (await prisma.stockOrder.findMany({
    where: { company: { isPremium: true } },
    orderBy: { createdAt: "asc" },
    take: 300,
  })) as { id: string; companyId: string; issuerId: string; side: "BUY" | "SELL"; shares: number; limitPrice: number }[];
  if (orders.length === 0) return;
  const held = await heldByIssuer();
  const issuers = (await prisma.company.findMany({
    where: { id: { in: [...new Set(orders.map((o) => o.issuerId))] } },
    select: { id: true, name: true, sharePrice: true },
  })) as { id: string; name: string; sharePrice: number }[];
  const byId = new Map(issuers.map((i) => [i.id, i]));
  for (const o of orders) {
    const issuer = byId.get(o.issuerId);
    if (!issuer) {
      await prisma.stockOrder.delete({ where: { id: o.id } });
      continue;
    }
    const price = marketPrice(issuer.sharePrice, held.get(issuer.id) ?? 0);
    const hit = o.side === "BUY" ? price <= o.limitPrice : price >= o.limitPrice;
    if (!hit) continue;
    const r = await executeTrade(o.companyId, o.issuerId, o.side, o.shares);
    if (r.ok) {
      await prisma.stockOrder.delete({ where: { id: o.id } });
      held.set(issuer.id, (held.get(issuer.id) ?? 0) + (o.side === "BUY" ? o.shares : -o.shares));
      const amount = o.side === "BUY" ? r.cost : r.proceeds;
      await notify?.(
        o.companyId,
        "Ordre de bourse exécuté",
        `${o.side === "BUY" ? "Achat" : "Vente"} de ${o.shares} actions ${issuer.name} à ${price.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} pi. (${(amount ?? 0).toLocaleString("fr-FR")} pi.)`
      ).catch(() => {});
    } else if (!r.retry) {
      await prisma.stockOrder.delete({ where: { id: o.id } });
      await notify?.(o.companyId, "Ordre de bourse annulé", `${issuer.name} : ${r.error}`).catch(() => {});
    }
  }
}

/* ---------------- alertes des abonnés (1.7) ---------------- */

export async function runPremiumAlerts(notify?: Notify) {
  const now = Date.now();
  // une gare qui sort de sa période de protection peut être rachetée à tout moment
  const exposed = (await prisma.stationOwnership.findMany({
    where: { protectionNotified: false, protectedUntil: { lte: new Date(now) }, company: { isPremium: true } },
    select: { station: true, companyId: true, invested: true },
  })) as { station: string; companyId: string; invested: number }[];
  for (const s of exposed) {
    await prisma.stationOwnership.update({ where: { station: s.station }, data: { protectionNotified: true } });
    await notify?.(s.companyId, "Gare exposée au rachat", `La protection de la gare de ${s.station} est terminée : un concurrent peut maintenant vous la racheter.`).catch(() => {});
  }
  // trésorerie trop basse pour l'échéance qui arrive dans le quart d'heure
  const loans = (await prisma.loan.findMany({
    where: { closedAt: null, lastPaidAt: { lte: new Date(now - 45 * 60_000) }, company: { isPremium: true } },
    select: { id: true, companyId: true, remaining: true, totalDue: true, hours: true, lastPaidAt: true, warnedAt: true, company: { select: { balance: true } } },
  })) as { id: string; companyId: string; remaining: number; totalDue: number; hours: number; lastPaidAt: Date; warnedAt: Date | null; company: { balance: number } | null }[];
  for (const l of loans) {
    const due = Math.min(installmentOf(l), l.remaining);
    if ((l.company?.balance ?? 0) >= due) continue;
    if (l.warnedAt && new Date(l.warnedAt).getTime() >= new Date(l.lastPaidAt).getTime()) continue;
    await prisma.loan.update({ where: { id: l.id }, data: { warnedAt: new Date() } });
    await notify?.(l.companyId, "Échéance en danger", `Il vous manque ${(due - (l.company?.balance ?? 0)).toLocaleString("fr-FR")} pi. pour la prochaine échéance de ${due.toLocaleString("fr-FR")} pi.`).catch(() => {});
  }
}

/* ---------------- historique du rapport (1.7, Premium) ---------------- */

export async function reportHistory(companyId: string, weeks = 4) {
  const out = [];
  for (let i = 0; i < weeks; i++) {
    const r = await weeklyReport(companyId, i);
    out.push({
      from: r.from,
      to: r.to,
      current: r.current,
      net: r.net,
      operating: r.operating,
      trips: r.trips,
      incidents: r.incidents,
      income: r.income.reduce((a, x) => a + x.amount, 0),
      expenses: r.expenses.reduce((a, x) => a + x.amount, 0),
      bestLine: r.lines[0]?.name ?? null,
    });
  }
  return out;
}
