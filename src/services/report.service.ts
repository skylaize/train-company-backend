import { prisma } from "../prisma";
import { sendToCompany } from "./push.service";
import { parseHistory } from "./market.service";
import { TICKS_PER_HOUR } from "./staff.service";

/* ============================================================
   Rentabilité détaillée et bilan de retour (Premium).

   Deux lectures des mêmes écritures comptables :
   - la RENTABILITÉ regarde les sept derniers jours, rame par rame et ligne
     par ligne, pour répondre à « qu'est-ce qui me rapporte, qu'est-ce qui me
     coûte ? » ;
   - le BILAN regarde la fenêtre où le joueur n'était pas là, pour répondre à
     « que s'est-il passé pendant mon absence ? ».

   Rien ici ne rapporte une pièce : c'est de l'information, pas du rendement.
   ============================================================ */

const DAY_MS = 24 * 3600_000;
export const STATS_WINDOW_MS = 7 * DAY_MS;

/* Au-delà de ce délai sans activité, le retour du joueur ouvre un bilan. En
   dessous, c'est une pause café : un écran de plus serait du bruit. */
export const ABSENCE_MIN_MS = 3 * 3600_000;

// l'activité n'est enregistrée qu'une fois par minute : le tableau de bord interroge le serveur bien plus souvent
const ACTIVITY_WRITE_MS = 60_000;

type GroupRow = { trainId?: string | null; lineId?: string | null; type: string; _sum: { amount: number | null }; _count: { _all: number } };

/* ---------------- activité et fenêtre d'absence ---------------- */

/* Appelée à chaque chargement de la compagnie. Quand le joueur revient après
   une absence, on fige la fenêtre [départ, retour] et le solde aux deux bouts :
   le bilan se calcule dessus, même si le joueur recharge la page trois fois. */
export async function touchActivity(company: {
  id: string;
  balance: number;
  lastActiveAt: Date | null;
}) {
  const now = Date.now();
  const last = company.lastActiveAt ? new Date(company.lastActiveAt).getTime() : null;
  if (last !== null && now - last < ACTIVITY_WRITE_MS) return;

  const activity = { lastActiveAt: new Date(now), lastActiveBalance: company.balance };

  if (last !== null && now - last >= ABSENCE_MIN_MS) {
    const prev = await prisma.company.findUnique({
      where: { id: company.id },
      select: { lastActiveBalance: true },
    });
    await prisma.company
      .update({
        where: { id: company.id },
        data: {
          ...activity,
          absenceFrom: new Date(last),
          absenceTo: new Date(now),
          absenceFromBalance: prev?.lastActiveBalance ?? company.balance,
          absenceToBalance: company.balance,
        },
      })
      .catch(() => undefined);
    return;
  }

  await prisma.company.update({ where: { id: company.id }, data: activity }).catch(() => undefined);
}

/* ---------------- rentabilité ---------------- */

export async function profitability(companyId: string) {
  const now = Date.now();
  const windowStart = new Date(now - STATS_WINDOW_MS);

  const [trains, lines, firstTagged] = await Promise.all([
    prisma.train.findMany({
      where: { companyId },
      select: { id: true, name: true, model: true, status: true, wear: true, lineId: true, purchasedAt: true },
    }),
    prisma.line.findMany({
      where: { companyId },
      select: { id: true, name: true, departureStation: true, arrivalStation: true, durationMinutes: true, createdAt: true },
    }),
    // les écritures d'avant la mise à jour n'ont pas de rame : on mesure depuis la première qui en a une
    prisma.transaction.findFirst({
      where: { companyId, trainId: { not: null }, createdAt: { gte: windowStart } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  const since = firstTagged ? new Date(firstTagged.createdAt) : null;
  const sinceMs = since ? since.getTime() : now;
  const trainIds = (trains as { id: string }[]).map((t) => t.id);

  const [byTrain, byLine, autoRepairs, breakdownIncidents, delayIncidents, upkeep, daily] = await Promise.all([
    // primes d'assurance à part (écritures de fret négatives), sinon elles se mêlent aux recettes
    prisma.transaction.groupBy({
      by: ["trainId", "type"],
      where: { companyId, trainId: { not: null }, createdAt: { gte: windowStart }, NOT: { type: "FRET", amount: { lt: 0 } } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.transaction.groupBy({
      by: ["lineId", "type"],
      where: { companyId, lineId: { not: null }, createdAt: { gte: windowStart } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.transaction.groupBy({
      by: ["trainId"],
      where: {
        companyId,
        type: "REPARATION",
        trainId: { not: null },
        description: { startsWith: "Réparation automatique" },
        createdAt: { gte: windowStart },
      },
      _count: { _all: true },
    }),
    trainIds.length
      ? prisma.incident.groupBy({
          by: ["trainId"],
          where: { trainId: { in: trainIds }, message: { contains: "en panne" }, createdAt: { gte: windowStart } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    trainIds.length
      ? prisma.incident.groupBy({
          by: ["trainId"],
          where: { trainId: { in: trainIds }, message: { startsWith: "Retard" }, createdAt: { gte: windowStart } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    prisma.transaction.aggregate({
      where: { companyId, type: "ENTRETIEN", createdAt: { gte: since ?? new Date(now) } },
      _sum: { amount: true },
    }),
    dailySeries(companyId, windowStart),
  ]);

  const countBy = (rows: unknown) =>
    new Map((rows as { trainId: string; _count: { _all: number } }[]).map((r) => [r.trainId, r._count._all]));
  const autoMap = countBy(autoRepairs);
  const breakMap = countBy(breakdownIncidents);
  const delayMap = countBy(delayIncidents);

  const agg = (rows: GroupRow[], key: "trainId" | "lineId", id: string) => {
    let lineRevenue = 0, freightRevenue = 0, repairs = 0, trips = 0, deliveries = 0, repairCount = 0;
    for (const r of rows) {
      if (r[key] !== id) continue;
      const sum = r._sum.amount ?? 0;
      if (r.type === "REVENU_LIGNE") { lineRevenue += sum; trips += r._count._all; }
      else if (r.type === "FRET") { freightRevenue += sum; deliveries += r._count._all; }
      else if (r.type === "REPARATION") { repairs += -sum; repairCount += r._count._all; }
    }
    return { lineRevenue, freightRevenue, repairs, trips, deliveries, repairCount };
  };

  const insuranceByTrain = await prisma.transaction.groupBy({
    by: ["trainId"],
    where: { companyId, type: "FRET", amount: { lt: 0 }, trainId: { not: null }, createdAt: { gte: windowStart } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const insMap = new Map(
    (insuranceByTrain as { trainId: string; _sum: { amount: number | null }; _count: { _all: number } }[]).map((r) => [
      r.trainId,
      { amount: -(r._sum.amount ?? 0), count: r._count._all },
    ])
  );

  const lineLabel = new Map(
    (lines as { id: string; departureStation: string; arrivalStation: string }[]).map((l) => [
      l.id,
      `${l.departureStation} → ${l.arrivalStation}`,
    ])
  );

  const trainRows = (trains as {
    id: string; name: string; model: string; status: string; wear: number; lineId: string | null; purchasedAt: Date;
  }[]).map((t) => {
    const a = agg(byTrain as GroupRow[], "trainId", t.id);
    const freightRevenue = a.freightRevenue;
    const deliveries = a.deliveries;
    const insurance = insMap.get(t.id)?.amount ?? 0;
    const revenue = a.lineRevenue + freightRevenue;
    const net = revenue - a.repairs - insurance;
    const observedFrom = Math.max(sinceMs, new Date(t.purchasedAt).getTime());
    const hours = Math.max(1, (now - observedFrom) / 3600_000);
    return {
      id: t.id,
      name: t.name,
      model: t.model,
      status: t.status,
      wear: t.wear,
      line: t.lineId ? lineLabel.get(t.lineId) ?? null : null,
      revenue,
      lineRevenue: a.lineRevenue,
      freightRevenue,
      insurance,
      repairs: a.repairs,
      trips: a.trips,
      deliveries,
      breakdowns: (autoMap.get(t.id) ?? 0) + (breakMap.get(t.id) ?? 0),
      delays: delayMap.get(t.id) ?? 0,
      net,
      netPerHour: Math.round(net / hours),
      hoursObserved: Math.round(hours),
    };
  });

  const lineRows = (lines as {
    id: string; name: string; departureStation: string; arrivalStation: string; durationMinutes: number; createdAt: Date;
  }[]).map((l) => {
    const a = agg(byLine as GroupRow[], "lineId", l.id);
    const observedFrom = Math.max(sinceMs, new Date(l.createdAt).getTime());
    const hours = Math.max(1, (now - observedFrom) / 3600_000);
    const net = a.lineRevenue - a.repairs;
    return {
      id: l.id,
      name: l.name,
      label: `${l.departureStation} → ${l.arrivalStation}`,
      durationMinutes: l.durationMinutes,
      trainsNow: (trains as { lineId: string | null }[]).filter((t) => t.lineId === l.id).length,
      revenue: a.lineRevenue,
      trips: a.trips,
      perTrip: a.trips ? Math.round(a.lineRevenue / a.trips) : 0,
      repairs: a.repairs,
      net,
      netPerHour: Math.round(net / hours),
    };
  });

  const totals = {
    lineRevenue: trainRows.reduce((s, t) => s + t.lineRevenue, 0),
    freightRevenue: trainRows.reduce((s, t) => s + t.freightRevenue, 0),
    repairs: trainRows.reduce((s, t) => s + t.repairs, 0),
    insurance: trainRows.reduce((s, t) => s + t.insurance, 0),
    upkeep: -((upkeep as { _sum: { amount: number | null } })._sum.amount ?? 0),
    breakdowns: trainRows.reduce((s, t) => s + t.breakdowns, 0),
  };

  const payroll = await prisma.staff.aggregate({ where: { companyId }, _sum: { salaryPerTick: true } });

  return {
    since,
    windowDays: 7,
    trains: trainRows.sort((a, b) => b.net - a.net),
    lines: lineRows.sort((a, b) => b.netPerHour - a.netPerHour),
    totals,
    payrollPerHour: ((payroll as { _sum: { salaryPerTick: number | null } })._sum.salaryPerTick ?? 0) * TICKS_PER_HOUR,
    daily,
  };
}

/* Recettes et réparations par jour, heure de Paris. Le regroupement se fait en
   SQL : ramener des milliers d'écritures pour les additionner ici serait absurde. */
async function dailySeries(companyId: string, from: Date) {
  const rows = (await prisma.$queryRaw`
    SELECT to_char(date_trunc('day', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris'), 'YYYY-MM-DD') AS day,
           COALESCE(SUM(CASE WHEN type IN ('REVENU_LIGNE', 'FRET') AND amount > 0 THEN amount ELSE 0 END), 0)::int AS revenue,
           COALESCE(SUM(CASE WHEN type = 'REPARATION' THEN -amount ELSE 0 END), 0)::int AS repairs,
           COALESCE(SUM(CASE WHEN type = 'ENTRETIEN' THEN -amount ELSE 0 END), 0)::int AS upkeep
    FROM "Transaction"
    WHERE "companyId" = ${companyId} AND "createdAt" >= ${from}
    GROUP BY 1
    ORDER BY 1
  `) as { day: string; revenue: number; repairs: number; upkeep: number }[];

  // sept cases, même les jours sans écriture : un trou dans la série serait illisible
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: { day: string; revenue: number; repairs: number; upkeep: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = parisDay(new Date(Date.now() - i * DAY_MS));
    const r = byDay.get(d);
    out.push({ day: d, revenue: Number(r?.revenue ?? 0), repairs: Number(r?.repairs ?? 0), upkeep: Number(r?.upkeep ?? 0) });
  }
  return out;
}

export function parisDay(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function parisHour(d: Date) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }).format(d));
}

/* ---------------- bilan d'une fenêtre ---------------- */

export async function windowReport(companyId: string, from: Date, to: Date) {
  const where = { companyId, createdAt: { gte: from, lte: to } };

  const [byType, autoRepairs, trainIds, constructions, staffLeft, raises, broken] = await Promise.all([
    // sans les primes d'assurance, pour que « fret » compte des livraisons et non des primes
    prisma.transaction.groupBy({
      by: ["type"],
      where: { ...where, NOT: { type: "FRET", amount: { lt: 0 } } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.transaction.count({
      where: { ...where, type: "REPARATION", description: { startsWith: "Réparation automatique" } },
    }),
    prisma.train.findMany({ where: { companyId }, select: { id: true } }),
    prisma.construction.findMany({
      where: { companyId, done: true, endsAt: { gte: from, lte: to } },
      select: { label: true },
    }),
    prisma.transaction.count({ where: { ...where, type: "PERSONNEL", description: { contains: "quitté" } } }),
    prisma.staff.findMany({ where: { companyId, raiseRequested: true }, select: { name: true } }),
    prisma.train.findMany({ where: { companyId, status: "MAINTENANCE" }, select: { name: true } }),
  ]);

  const ids = (trainIds as { id: string }[]).map((t) => t.id);
  const breakdowns = ids.length
    ? await prisma.incident.count({ where: { trainId: { in: ids }, message: { contains: "en panne" }, createdAt: { gte: from, lte: to } } })
    : 0;

  const t = new Map(
    (byType as { type: string; _sum: { amount: number | null }; _count: { _all: number } }[]).map((r) => [
      r.type,
      { sum: r._sum.amount ?? 0, count: r._count._all },
    ])
  );
  const get = (k: string) => t.get(k) ?? { sum: 0, count: 0 };

  // meilleure ligne sur la fenêtre
  const lineRows = await prisma.transaction.groupBy({
    by: ["lineId"],
    where: { ...where, type: "REVENU_LIGNE", lineId: { not: null } },
    _sum: { amount: true },
    orderBy: { _sum: { amount: "desc" } },
    take: 1,
  });
  let bestLine: { label: string; revenue: number } | null = null;
  const top = (lineRows as { lineId: string; _sum: { amount: number | null } }[])[0];
  if (top) {
    const line = await prisma.line.findUnique({ where: { id: top.lineId }, select: { departureStation: true, arrivalStation: true } });
    if (line) bestLine = { label: `${line.departureStation} → ${line.arrivalStation}`, revenue: top._sum.amount ?? 0 };
  }

  return {
    lineRevenue: get("REVENU_LIGNE").sum,
    trips: get("REVENU_LIGNE").count,
    freight: get("FRET").sum,
    deliveries: get("FRET").count,
    repairs: -get("REPARATION").sum,
    repairCount: get("REPARATION").count,
    autoRepairs,
    breakdowns: breakdowns + autoRepairs,
    upkeep: -get("ENTRETIEN").sum,
    marketTrades: get("ACHAT_FRET").count + get("VENTE_FRET").count,
    marketNet: get("ACHAT_FRET").sum + get("VENTE_FRET").sum,
    constructionsDone: (constructions as { label: string }[]).map((c) => c.label),
    staffLeft,
    raiseRequests: (raises as { name: string }[]).map((r) => r.name || "Un employé"),
    brokenNow: (broken as { name: string }[]).map((b) => b.name),
    bestLine,
  };
}

/* Les cours qui ont le plus bougé depuis le départ du joueur. L'historique ne
   couvre que huit heures : au-delà, on compare au plus ancien relevé et on le dit. */
export async function marketMovers(from: Date) {
  const markets = (await prisma.cargoMarket.findMany()) as { cargoType: string; index: number; history: string }[];
  const movers = markets
    .map((m) => {
      const h = parseHistory(m.history);
      if (h.length === 0) return null;
      const ref = h.find((p) => p.t >= from.getTime()) ?? h[0];
      const change = ref.i > 0 ? (m.index - ref.i) / ref.i : 0;
      return { cargoType: m.cargoType, change: Math.round(change * 1000) / 10, since: ref.t };
    })
    .filter((x): x is { cargoType: string; change: number; since: number } => x !== null)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return movers.slice(0, 3);
}

/* ---------------- bilan du matin ---------------- */

/* Une fois par jour, vers 8 h (Paris), un résumé de la nuit part en
   notification aux abonnés qui ne sont pas revenus depuis au moins six heures.
   Celui qui a joué jusqu'à 7 h 50 n'a pas besoin qu'on lui raconte sa nuit. */
const DIGEST_HOUR = 8;
const DIGEST_LAST_HOUR = 11; // passé 11 h, on ne rattrape pas un bilan manqué : il ne serait plus « du matin »
const DIGEST_MIN_AWAY_MS = 6 * 3600_000;

export async function runMorningDigest() {
  const now = new Date();
  const hour = parisHour(now);
  if (hour < DIGEST_HOUR || hour >= DIGEST_LAST_HOUR) return;
  const today = parisDay(now);

  const companies = (await prisma.company.findMany({
    where: {
      isPremium: true,
      OR: [{ lastDigestOn: null }, { lastDigestOn: { not: today } }],
      pushSubscriptions: { some: {} },
    },
    select: { id: true, balance: true, lastActiveAt: true, lastActiveBalance: true },
    take: 200,
  })) as { id: string; balance: number; lastActiveAt: Date | null; lastActiveBalance: number | null }[];

  for (const c of companies) {
    // marqué d'abord : un envoi qui échoue ne doit pas être retenté à chaque tick
    await prisma.company.update({ where: { id: c.id }, data: { lastDigestOn: today } });

    if (!c.lastActiveAt) continue;
    const awayMs = now.getTime() - new Date(c.lastActiveAt).getTime();
    if (awayMs < DIGEST_MIN_AWAY_MS) continue;

    const r = await windowReport(c.id, new Date(c.lastActiveAt), now);
    const net = c.balance - (c.lastActiveBalance ?? c.balance);
    const parts = [`${net >= 0 ? "+" : ""}${net.toLocaleString("fr-FR")} pi. en ${Math.round(awayMs / 3600_000)} h`];
    if (r.breakdowns) parts.push(`${r.breakdowns} panne${r.breakdowns > 1 ? "s" : ""}${r.autoRepairs ? ` (${r.autoRepairs} réparée${r.autoRepairs > 1 ? "s" : ""} d'office)` : ""}`);
    if (r.constructionsDone.length) parts.push(`${r.constructionsDone.length} chantier${r.constructionsDone.length > 1 ? "s" : ""} terminé${r.constructionsDone.length > 1 ? "s" : ""}`);
    if (r.raiseRequests.length) parts.push(`${r.raiseRequests.length} demande${r.raiseRequests.length > 1 ? "s" : ""} d'augmentation`);
    if (r.brokenNow.length) parts.push(`${r.brokenNow.length} rame${r.brokenNow.length > 1 ? "s" : ""} à l'arrêt`);

    await sendToCompany(c.id, {
      title: "Votre compagnie cette nuit",
      body: parts.join(" · "),
      url: "/dashboard",
      tag: "bilan",
    });
  }
}
