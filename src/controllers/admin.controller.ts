import crypto from "crypto";
import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { adminConfigured, logAdmin, markBanned } from "../services/admin.service";
import { buildLeaderRows } from "../services/leaderboard.service";
import { currentSeason, DIVISIONS, invalidateSeason } from "../services/saison.service";
import { allianceRanking, invalidateAlliances } from "../services/alliance.service";
import { ensureProject, TUNNEL_ID } from "../services/world.service";
import { findAnyItem, SHOP_ITEMS, DISCORD_ITEMS, AD_FREE_ITEM } from "../services/shop.service";
import { GIFT_FROM, parsePrize, prizeLabel, PRIZE_CHOICES, MAX_GIFT_COINS } from "../services/gift.service";
import { grantTrial, MAX_TRIAL_DAYS } from "../services/trial.service";
import { sendToCompany, pushEnabled } from "../services/push.service";
import { syncCompany, clearRoles } from "../services/discord-roles.service";
import { botEnabled, BRAND_COLOR, channelId, CHANNELS, ChannelKey, DiscordFile, GUILD_ID, NOTIFY_ROLES, NotifyRole, postOnce, rest } from "../services/discord.service";
import { createGiveaway, finishGiveaway, rerollGiveaway, parseDuration, MIN_DURATION_MS, MAX_DURATION_MS, MAX_WINNERS } from "../services/giveaway.service";
import { LIVERY_PREMIUM } from "./company.controller";
import { TRAIN_MODELS, trainValue } from "./train.controller";
import { heritageOf } from "../services/wreck.service";
import { CARS } from "../services/ridership.service";
import { WAGONS } from "../services/freight.service";

/* ============================================================
   Panneau d'administration (2.2) — /api/admin/*

   Tout passe par requireAuth + requireAdmin (voir admin.routes). Chaque
   action qui modifie quelque chose est inscrite au journal (AdminAction)
   et recopiée dans #logs sur Discord.
   ============================================================ */

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const actor = (req: AuthRequest) => ({ id: req.admin!.id, name: req.admin!.name });
const bad = (res: Response, status: number, error: string) => res.status(status).json({ error });
const str = (v: unknown, max = 500) => String(v ?? "").trim().slice(0, max);
const int = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : NaN;
};
const fmt = (n: number) => new Intl.NumberFormat("fr-FR").format(Math.round(n));

async function companyOr404(res: Response, id: string) {
  const c = await prisma.company.findUnique({
    where: { id },
    select: { id: true, name: true, ownerId: true, isPremium: true, premiumTrialUntil: true, liveryColor: true, balance: true },
  });
  if (!c) bad(res, 404, "Compagnie introuvable");
  return c;
}

/* ---------------- moi ---------------- */

export function adminMe(req: AuthRequest, res: Response) {
  res.json({ ok: true, name: req.admin!.name, email: req.admin!.email, configured: adminConfigured() });
}

/* ---------------- vue d'ensemble ---------------- */

/* Recettes encaissées par Stripe (Premium + boutique), gardées cinq minutes :
   le Premium n'enregistre pas son montant en base, Stripe est la seule
   source exacte. */
let stripeCache: { at: number; data: { d7: number; d30: number; count30: number; byDay: Record<string, number> } | null } | null = null;
async function stripeRevenue() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (stripeCache && Date.now() - stripeCache.at < 5 * 60_000) return stripeCache.data;
  try {
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(key);
    const since = Math.floor(ago(30).getTime() / 1000);
    const d7 = ago(7).getTime();
    let total7 = 0;
    let total30 = 0;
    let count30 = 0;
    const byDay: Record<string, number> = {};
    let seen = 0;
    for await (const s of stripe.checkout.sessions.list({ created: { gte: since }, status: "complete", limit: 100 })) {
      if (++seen > 2000) break;
      if (s.payment_status !== "paid") continue;
      const cents = s.amount_total ?? 0;
      const at = s.created * 1000;
      total30 += cents;
      count30++;
      if (at >= d7) total7 += cents;
      const day = parisDay(new Date(at));
      byDay[day] = (byDay[day] ?? 0) + cents;
    }
    stripeCache = { at: Date.now(), data: { d7: total7, d30: total30, count30, byDay } };
  } catch (err) {
    console.error("[admin] Stripe :", (err as Error).message);
    stripeCache = { at: Date.now(), data: null };
  }
  return stripeCache.data;
}

function parisDay(d: Date) {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function last30Days() {
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) days.push(parisDay(ago(i)));
  return days;
}

export async function overview(_req: AuthRequest, res: Response) {
  const [d1, d7, d30] = [ago(1), ago(7), ago(30)];
  const [
    users, companies, new1, new7, new30, active1, active7, premiumPaid, premiumTrials, banned, linked,
    shop7, shop30, coins, openGiveaways, alliances, recentCompanies, recentActive,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.company.count(),
    prisma.company.count({ where: { createdAt: { gte: d1 } } }),
    prisma.company.count({ where: { createdAt: { gte: d7 } } }),
    prisma.company.count({ where: { createdAt: { gte: d30 } } }),
    prisma.company.count({ where: { lastActiveAt: { gte: d1 } } }),
    prisma.company.count({ where: { lastActiveAt: { gte: d7 } } }),
    prisma.company.count({ where: { isPremium: true, premiumTrialUntil: null } }),
    prisma.company.count({ where: { premiumTrialUntil: { not: null } } }),
    prisma.user.count({ where: { bannedAt: { not: null } } }),
    prisma.user.count({ where: { discordId: { not: null } } }),
    prisma.shopPurchase.aggregate({ where: { purchasedAt: { gte: d7 }, amountCents: { gt: 0 } }, _sum: { amountCents: true }, _count: { _all: true } }),
    prisma.shopPurchase.aggregate({ where: { purchasedAt: { gte: d30 }, amountCents: { gt: 0 } }, _sum: { amountCents: true }, _count: { _all: true } }),
    prisma.company.aggregate({ _sum: { balance: true }, _avg: { balance: true } }),
    prisma.giveaway.count({ where: { endedAt: null } }),
    prisma.alliance.count(),
    prisma.company.findMany({ where: { createdAt: { gte: d30 } }, select: { createdAt: true } }),
    prisma.company.findMany({ where: { lastActiveAt: { gte: d1 } }, select: { lastActiveAt: true } }),
  ]);

  const days = last30Days();
  const signups: Record<string, number> = Object.fromEntries(days.map((d) => [d, 0]));
  for (const c of recentCompanies as { createdAt: Date }[]) {
    const k = parisDay(c.createdAt);
    if (k in signups) signups[k]++;
  }
  // joueurs vus dans l'heure, par heure sur les dernières 24 h
  const hours = Array.from({ length: 24 }, () => 0);
  for (const c of recentActive as { lastActiveAt: Date | null }[]) {
    if (!c.lastActiveAt) continue;
    const h = Math.floor((Date.now() - c.lastActiveAt.getTime()) / 3_600_000);
    if (h >= 0 && h < 24) hours[23 - h]++;
  }

  const stripe = await stripeRevenue();

  let discordMembers: number | null = null;
  if (botEnabled()) {
    const g = await rest<{ approximate_member_count?: number }>("GET", `/guilds/${GUILD_ID}?with_counts=true`).catch(() => null);
    discordMembers = g?.approximate_member_count ?? null;
  }

  const season = await currentSeason();
  const seasonRanked = season ? await prisma.seasonEntry.count({ where: { seasonId: season.id, points: { gt: 0 } } }) : 0;
  const world = await ensureProject().catch(() => null);

  const rows = await buildLeaderRows().catch(() => []);
  const top = [...rows].sort((a, b) => b.valeur - a.valeur).slice(0, 10).map((r) => ({ id: r.id, name: r.name, liveryColor: r.liveryColor, valeur: r.valeur, trains: r.trains, lines: r.lines }));

  res.json({
    players: { users, companies, new1, new7, new30, active1, active7, banned, linked },
    premium: { paid: premiumPaid, trials: premiumTrials },
    revenue: {
      shop7: shop7._sum.amountCents ?? 0,
      shop30: shop30._sum.amountCents ?? 0,
      shopCount30: shop30._count._all,
      stripe7: stripe?.d7 ?? null,
      stripe30: stripe?.d30 ?? null,
      stripeCount30: stripe?.count30 ?? null,
      byDay: days.map((d) => ({ day: d, cents: stripe?.byDay[d] ?? 0 })),
    },
    economy: { coins: coins._sum.balance ?? 0, avgBalance: Math.round(coins._avg.balance ?? 0) },
    signups: days.map((d) => ({ day: d, count: signups[d] })),
    activeByHour: hours,
    discord: { bot: botEnabled(), members: discordMembers, linked, openGiveaways },
    season: season ? { id: season.id, number: season.number, name: season.name, startsAt: season.startsAt, endsAt: season.endsAt, ranked: seasonRanked } : null,
    world: world ? { id: world.id, name: world.name, target: world.target, progress: world.progress, completedAt: world.completedAt } : null,
    alliances,
    top,
    push: pushEnabled(),
  });
}

/* ---------------- joueurs ---------------- */

const PAGE = 30;

export async function listPlayers(req: AuthRequest, res: Response) {
  const q = str(req.query.q, 80);
  const filter = str(req.query.filter, 20) || "tous";
  const sort = str(req.query.sort, 20) || "valeur";
  const page = Math.max(0, int(req.query.page) || 0);

  const where: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];
  if (q) {
    and.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { owner: { pseudo: { contains: q, mode: "insensitive" } } },
        { owner: { email: { contains: q, mode: "insensitive" } } },
        { owner: { discordName: { contains: q, mode: "insensitive" } } },
        { id: q },
      ],
    });
  }
  if (filter === "premium") and.push({ isPremium: true, premiumTrialUntil: null });
  if (filter === "essai") and.push({ premiumTrialUntil: { not: null } });
  if (filter === "suspendus") and.push({ owner: { bannedAt: { not: null } } });
  if (filter === "actifs") and.push({ lastActiveAt: { gte: ago(1) } });
  if (filter === "inactifs") and.push({ OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: ago(7) } }] });
  if (filter === "discord") and.push({ owner: { discordId: { not: null } } });
  if (and.length) where.AND = and;

  const rows = (await prisma.company.findMany({
    where,
    select: {
      id: true, name: true, liveryColor: true, emblem: true, balance: true, isPremium: true, premiumTrialUntil: true,
      createdAt: true, lastActiveAt: true, pioneerNumber: true, division: true,
      owner: { select: { id: true, pseudo: true, email: true, discordName: true, bannedAt: true } },
      _count: { select: { trains: true, lines: true } },
    },
  })) as {
    id: string; name: string; liveryColor: string; emblem: string | null; balance: number; isPremium: boolean; premiumTrialUntil: Date | null;
    createdAt: Date; lastActiveAt: Date | null; pioneerNumber: number | null; division: number;
    owner: { id: string; pseudo: string; email: string; discordName: string | null; bannedAt: Date | null };
    _count: { trains: number; lines: number };
  }[];

  const worth = new Map((await buildLeaderRows().catch(() => [])).map((r) => [r.id, r.valeur]));
  const list = rows.map((c) => ({
    id: c.id,
    name: c.name,
    liveryColor: c.liveryColor,
    emblem: c.emblem,
    pseudo: c.owner.pseudo,
    email: c.owner.email,
    discordName: c.owner.discordName,
    banned: Boolean(c.owner.bannedAt),
    premium: c.isPremium ? (c.premiumTrialUntil ? "essai" : "oui") : "non",
    balance: c.balance,
    valeur: worth.get(c.id) ?? c.balance,
    trains: c._count.trains,
    lines: c._count.lines,
    division: DIVISIONS[c.division] ?? "—",
    pioneer: c.pioneerNumber,
    createdAt: c.createdAt,
    lastActiveAt: c.lastActiveAt,
  }));

  const by: Record<string, (a: (typeof list)[number], b: (typeof list)[number]) => number> = {
    valeur: (a, b) => b.valeur - a.valeur,
    tresorerie: (a, b) => b.balance - a.balance,
    recents: (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
    actifs: (a, b) => +new Date(b.lastActiveAt ?? 0) - +new Date(a.lastActiveAt ?? 0),
    nom: (a, b) => a.name.localeCompare(b.name, "fr"),
  };
  list.sort(by[sort] ?? by.valeur);
  res.json({ total: list.length, page, pageSize: PAGE, players: list.slice(page * PAGE, page * PAGE + PAGE) });
}

export async function playerDetail(req: AuthRequest, res: Response) {
  const id = req.params.id;
  const c = (await prisma.company.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, email: true, pseudo: true, createdAt: true, discordId: true, discordName: true, bannedAt: true, bannedReason: true } },
      trains: {
        select: {
          id: true, name: true, model: true, status: true, wear: true, brokenPart: true, cars: true, purchasedAt: true, heritage: true,
          lineId: true, departedAt: true, progress: true, workshopUntil: true, partsEta: true, line: { select: { name: true } },
          _count: { select: { contracts: true } },
        },
        orderBy: { purchasedAt: "asc" },
      },
      lines: { select: { id: true, name: true, departureStation: true, arrivalStation: true, stops: true, priceRatio: true, _count: { select: { trains: true } } }, orderBy: { createdAt: "asc" } },
      shopPurchases: { select: { itemId: true, amountCents: true, purchasedAt: true, giftFrom: true, stripeSessionId: true }, orderBy: { purchasedAt: "desc" } },
      transactions: { select: { id: true, type: true, amount: true, description: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 60 },
      loans: { where: { closedAt: null }, select: { remaining: true, missed: true } },
      stationsOwned: { select: { station: true, level: true } },
      _count: { select: { achievementUnlocks: true, referrals: true, staff: true, contracts: true, pushSubscriptions: true } },
    },
  })) as any;
  if (!c) return bad(res, 404, "Compagnie introuvable");

  const [member, season, logs, worth] = await Promise.all([
    prisma.allianceMember.findUnique({ where: { companyId: id } }),
    currentSeason(),
    prisma.adminAction.findMany({ where: { targetId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
    buildLeaderRows().then((rows) => rows.find((r) => r.id === id)?.valeur ?? null).catch(() => null),
  ]);
  const alliance = member ? await prisma.alliance.findUnique({ where: { id: member.allianceId }, select: { id: true, name: true, color: true, founderId: true } }) : null;
  const entry = season ? await prisma.seasonEntry.findUnique({ where: { seasonId_companyId: { seasonId: season.id, companyId: id } } }) : null;

  res.json({
    id: c.id,
    name: c.name,
    liveryColor: c.liveryColor,
    emblem: c.emblem,
    title: c.title,
    balance: c.balance,
    valeur: worth,
    maxTrains: c.maxTrains,
    isPremium: c.isPremium,
    premiumTrialUntil: c.premiumTrialUntil,
    pioneerNumber: c.pioneerNumber,
    referralCode: c.referralCode,
    createdAt: c.createdAt,
    lastActiveAt: c.lastActiveAt,
    reputationAdjust: c.reputationAdjust,
    division: DIVISIONS[c.division] ?? "—",
    owner: c.owner,
    trains: c.trains.map((t: any) => ({
      id: t.id, name: t.name, model: t.model, status: t.status, wear: t.wear, broken: t.brokenPart, line: t.line?.name ?? null,
      progress: t.progress, departedAt: t.departedAt, workshopUntil: t.workshopUntil, partsEta: t.partsEta, freight: t._count.contracts,
      purchasedAt: t.purchasedAt,
      // 2.2 : ce qu'on peut rembourser si on la retire
      purchase: purchasePrice(t),
      resale: trainValue(t),
    })),
    lines: c.lines.map((l: any) => ({ id: l.id, name: l.name, route: [l.departureStation, ...(l.stops ?? []), l.arrivalStation], priceRatio: l.priceRatio, trains: l._count.trains })),
    purchases: c.shopPurchases.map((p: any) => ({
      itemId: p.itemId,
      name: findAnyItem(p.itemId)?.name ?? p.itemId,
      amountCents: p.amountCents,
      purchasedAt: p.purchasedAt,
      giftFrom: p.giftFrom,
      paid: p.amountCents > 0 && !String(p.stripeSessionId).startsWith("staff:") && !String(p.stripeSessionId).startsWith("admin:"),
    })),
    transactions: c.transactions,
    loans: { open: c.loans.length, remaining: c.loans.reduce((s: number, l: any) => s + l.remaining, 0) },
    stations: c.stationsOwned,
    counts: c._count,
    alliance: alliance ? { ...alliance, founder: alliance.founderId === id } : null,
    season: entry ? { division: DIVISIONS[entry.division], group: entry.groupNo, points: entry.points } : null,
    adminLog: logs,
  });
}

export async function updatePlayer(req: AuthRequest, res: Response) {
  const c = await companyOr404(res, req.params.id);
  if (!c) return;
  const changes: string[] = [];
  if (req.body?.name !== undefined) {
    const name = str(req.body.name, 40);
    if (name.length < 2) return bad(res, 400, "Nom de compagnie trop court");
    await prisma.company.update({ where: { id: c.id }, data: { name } });
    changes.push(`compagnie « ${c.name} » → « ${name} »`);
  }
  if (req.body?.pseudo !== undefined) {
    const pseudo = str(req.body.pseudo, 24);
    if (pseudo.length < 2) return bad(res, 400, "Pseudo trop court");
    await prisma.user.update({ where: { id: c.ownerId }, data: { pseudo } });
    changes.push(`pseudo → « ${pseudo} »`);
  }
  if (!changes.length) return bad(res, 400, "Rien à modifier");
  await logAdmin(actor(req), "RENOMMER", { id: c.id, label: c.name }, changes.join(", "));
  res.json({ ok: true });
}

export async function adjustCoins(req: AuthRequest, res: Response) {
  const c = await companyOr404(res, req.params.id);
  if (!c) return;
  const amount = int(req.body?.amount);
  const reason = str(req.body?.reason, 120) || "ajustement";
  if (!amount || Math.abs(amount) > 10_000_000) return bad(res, 400, "Montant invalide (de -10 000 000 à 10 000 000, sauf 0)");
  await prisma.$transaction([
    prisma.company.update({ where: { id: c.id }, data: { balance: { increment: amount } } }),
    prisma.transaction.create({
      data: {
        companyId: c.id,
        type: amount > 0 ? "CADEAU" : "AJUSTEMENT",
        amount,
        description: amount > 0 ? `Cadeau de ${GIFT_FROM} : ${reason}` : `Ajustement par ${GIFT_FROM} : ${reason}`,
      },
    }),
  ]);
  if (amount > 0 && req.body?.notify !== false) {
    void sendToCompany(c.id, { title: "Vous avez reçu un cadeau", body: `L'équipe de Réseau vous offre ${fmt(amount)} pi. (${reason}).`, url: "/dashboard", tag: "cadeau" });
  }
  await logAdmin(actor(req), "ARGENT", { id: c.id, label: c.name }, `${amount > 0 ? "+" : ""}${fmt(amount)} pi. (${reason})`);
  res.json({ ok: true, balance: c.balance + amount });
}

export async function setPremium(req: AuthRequest, res: Response) {
  const c = await companyOr404(res, req.params.id);
  if (!c) return;
  const mode = str(req.body?.mode, 20);
  const reason = str(req.body?.reason, 120) || "panneau admin";

  if (mode === "essai") {
    const days = int(req.body?.days);
    if (!(days >= 1 && days <= MAX_TRIAL_DAYS)) return bad(res, 400, `Un essai dure de 1 à ${MAX_TRIAL_DAYS} jours`);
    const t = await grantTrial(c.id, days);
    if (!t.ok) return bad(res, 409, `La compagnie ${t.reason}`);
    await prisma.transaction.create({ data: { companyId: c.id, type: "PREMIUM", amount: 0, description: `Cadeau de ${GIFT_FROM} : ${days} jours de Premium d'essai (${reason})` } });
    void sendToCompany(c.id, { title: "Premium offert !", body: `L'équipe de Réseau vous offre ${days} jours de Premium.`, url: "/dashboard", tag: "cadeau" });
    await logAdmin(actor(req), "PREMIUM", { id: c.id, label: c.name }, `essai de ${days} j jusqu'au ${t.until.toLocaleDateString("fr-FR")} (${reason})`);
    return res.json({ ok: true, until: t.until });
  }

  if (mode === "definitif") {
    if (c.isPremium && !c.premiumTrialUntil) return bad(res, 409, "Déjà Premium");
    await prisma.$transaction([
      // premiumReveal : l'animation « Premium offert par l'équipe de Réseau » au prochain passage
      prisma.company.update({ where: { id: c.id }, data: { isPremium: true, premiumTrialUntil: null, premiumTrialEndedAt: null, premiumReveal: GIFT_FROM } }),
      prisma.transaction.create({ data: { companyId: c.id, type: "PREMIUM", amount: 0, description: `Cadeau de ${GIFT_FROM} : Premium à vie (${reason})` } }),
    ]);
    void syncCompany(c.id).catch(() => undefined);
    void sendToCompany(c.id, { title: "Premium offert !", body: "L'équipe de Réseau vous offre le Premium, pour toujours.", url: "/dashboard", tag: "cadeau" });
    await logAdmin(actor(req), "PREMIUM", { id: c.id, label: c.name }, `Premium à vie offert (${reason})`);
    return res.json({ ok: true });
  }

  if (mode === "retirer") {
    if (!c.isPremium) return bad(res, 409, "Cette compagnie n'est pas Premium");
    await prisma.company.update({
      where: { id: c.id },
      data: {
        isPremium: false,
        premiumTrialUntil: null,
        ...(LIVERY_PREMIUM.includes(c.liveryColor.toLowerCase()) ? { liveryColor: "#f2a900" } : {}),
      },
    });
    void syncCompany(c.id).catch(() => undefined);
    await logAdmin(actor(req), "PREMIUM", { id: c.id, label: c.name }, `Premium retiré (${c.premiumTrialUntil ? "essai" : "définitif"}) — ${reason}`);
    return res.json({ ok: true });
  }

  return bad(res, 400, "Mode inconnu (essai, definitif, retirer)");
}

export async function grantItem(req: AuthRequest, res: Response) {
  const c = await companyOr404(res, req.params.id);
  if (!c) return;
  const item = findAnyItem(str(req.body?.itemId, 80));
  if (!item) return bad(res, 404, "Objet inconnu");
  const reason = str(req.body?.reason, 120) || "panneau admin";
  const owned = await prisma.shopPurchase.findUnique({ where: { companyId_itemId: { companyId: c.id, itemId: item.id } } });
  if (owned) return bad(res, 409, `Possède déjà ${item.name}`);
  await prisma.$transaction([
    prisma.shopPurchase.create({
      data: { companyId: c.id, itemId: item.id, stripeSessionId: `admin:${crypto.randomUUID()}`, amountCents: 0, giftFrom: GIFT_FROM },
    }),
    prisma.transaction.create({ data: { companyId: c.id, type: "BOUTIQUE", amount: 0, description: `Cadeau de ${GIFT_FROM} : ${item.name} (${reason})` } }),
  ]);
  void sendToCompany(c.id, { title: "Vous avez reçu un cadeau", body: `L'équipe de Réseau vous offre : ${item.name}. Ouvrez le jeu pour le déballer.`, url: "/dashboard", tag: "cadeau" });
  await logAdmin(actor(req), "OBJET", { id: c.id, label: c.name }, `offert : ${item.name} (${reason})`);
  res.json({ ok: true });
}

export async function revokeItem(req: AuthRequest, res: Response) {
  const c = await companyOr404(res, req.params.id);
  if (!c) return;
  const itemId = req.params.itemId;
  const row = await prisma.shopPurchase.findUnique({ where: { companyId_itemId: { companyId: c.id, itemId } } });
  if (!row) return bad(res, 404, "La compagnie ne possède pas cet objet");
  await prisma.shopPurchase.delete({ where: { id: row.id } });
  const name = findAnyItem(itemId)?.name ?? itemId;
  await logAdmin(actor(req), "OBJET", { id: c.id, label: c.name }, `retiré : ${name}${row.amountCents > 0 ? ` (payé ${(row.amountCents / 100).toFixed(2)} € — pense au remboursement Stripe)` : ""}`);
  res.json({ ok: true });
}

export async function banPlayer(req: AuthRequest, res: Response) {
  const c = await companyOr404(res, req.params.id);
  if (!c) return;
  if (c.ownerId === req.admin!.id) return bad(res, 400, "Vous ne pouvez pas suspendre votre propre compte");
  const reason = str(req.body?.reason, 200) || "non précisée";
  const user = await prisma.user.update({ where: { id: c.ownerId }, data: { bannedAt: new Date(), bannedReason: reason }, select: { discordId: true } });
  markBanned(c.ownerId, true);
  // plus de rôles de joueur sur Discord tant que la suspension dure
  if (user.discordId) void clearRoles(user.discordId).catch(() => undefined);
  await logAdmin(actor(req), "BAN", { id: c.id, label: c.name }, `compte suspendu : ${reason}`);
  res.json({ ok: true });
}

export async function unbanPlayer(req: AuthRequest, res: Response) {
  const c = await companyOr404(res, req.params.id);
  if (!c) return;
  await prisma.user.update({ where: { id: c.ownerId }, data: { bannedAt: null, bannedReason: null } });
  markBanned(c.ownerId, false);
  void syncCompany(c.id).catch(() => undefined);
  await logAdmin(actor(req), "BAN", { id: c.id, label: c.name }, "suspension levée");
  res.json({ ok: true });
}

export async function adjustSeasonPoints(req: AuthRequest, res: Response) {
  const c = await companyOr404(res, req.params.id);
  if (!c) return;
  const season = await currentSeason();
  if (!season) return bad(res, 409, "Pas de saison en cours");
  const delta = int(req.body?.points);
  const reset = req.body?.reset === true;
  if (!reset && (!delta || Math.abs(delta) > 1_000_000)) return bad(res, 400, "Nombre de points invalide");
  const entry = await prisma.seasonEntry.findUnique({ where: { seasonId_companyId: { seasonId: season.id, companyId: c.id } } });
  if (!entry) return bad(res, 409, "Cette compagnie n'est pas classée dans la saison en cours");
  const points = reset ? 0 : Math.max(0, entry.points + delta);
  await prisma.seasonEntry.update({ where: { id: entry.id }, data: { points } });
  await logAdmin(actor(req), "SAISON", { id: c.id, label: c.name }, reset ? `points de saison remis à 0 (avant : ${fmt(entry.points)})` : `points de saison ${delta > 0 ? "+" : ""}${fmt(delta)} → ${fmt(points)}`);
  res.json({ ok: true, points });
}

/* ---------------- rames : débloquer, retirer et rembourser ---------------- */

/* Ce que la rame a coûté : le modèle et ses voitures ou wagons au prix plein ;
   une rame de collection, tout ce qui a été investi pour la restaurer. */
function purchasePrice(t: { model: string; cars?: string[] | null; heritage?: unknown }) {
  const h = heritageOf(t as { heritage?: unknown });
  if (h) return Math.round(h.value);
  const cars = (t.cars ?? []).reduce((n, c) => n + (CARS[c]?.price ?? (WAGONS as Record<string, { price: number }>)[c]?.price ?? 0), 0);
  return (TRAIN_MODELS[t.model]?.cost ?? 200) + cars;
}

async function trainOr404(res: Response, companyId: string, trainId: string) {
  const t = await prisma.train.findFirst({ where: { id: trainId, companyId } });
  if (!t) bad(res, 404, "Rame introuvable");
  return t as any;
}

/* Une rame coincée (trajet qui ne finit plus, statut incohérent) revient au
   dépôt, à quai, prête à repartir. Son usure et ses organes ne bougent pas.
   Un fret en cours repart sur le marché. */
export async function resetTrain(req: AuthRequest, res: Response) {
  const c = await companyOr404(res, req.params.id);
  if (!c) return;
  const t = await trainOr404(res, c.id, req.params.trainId);
  if (!t) return;
  const repaired = req.body?.repair === true;
  const freed = await prisma.$transaction(async (tx: any) => {
    const contracts = await tx.contract.updateMany({
      where: { trainId: t.id, status: "EN_COURS" },
      data: { status: "DISPONIBLE", trainId: null, companyId: null, acceptedAt: null, tourMinutes: null },
    });
    await tx.train.update({
      where: { id: t.id },
      data: {
        status: "IDLE", lineId: null, progress: 0, departedAt: null, direction: 0, workshopUntil: null, partsEta: null,
        ...(repaired ? { wear: 0, brokenPart: null } : t.wear >= 100 || t.brokenPart ? { status: "MAINTENANCE" } : {}),
      },
    });
    return contracts.count;
  });
  await logAdmin(actor(req), "RAME", { id: c.id, label: c.name }, `${t.name} remise au dépôt${repaired ? " et réparée" : ""}${freed ? ` (${freed} contrat${freed > 1 ? "s" : ""} de fret rendu${freed > 1 ? "s" : ""} au marché)` : ""}`);
  res.json({ ok: true, freed });
}

/* Retire une rame du parc et rembourse le joueur : au prix d'achat, au prix
   de reprise du jour, d'un montant libre, ou pas du tout. */
export async function removeTrain(req: AuthRequest, res: Response) {
  const c = await companyOr404(res, req.params.id);
  if (!c) return;
  const t = await trainOr404(res, c.id, req.params.trainId);
  if (!t) return;
  const mode = str(req.body?.refund, 20) || "achat";
  const reason = str(req.body?.reason, 120) || "rame défectueuse";
  let refund = 0;
  if (mode === "achat") refund = purchasePrice(t);
  else if (mode === "revente") refund = trainValue(t);
  else if (mode === "montant") {
    refund = int(req.body?.amount);
    if (!(refund >= 0 && refund <= 1_000_000)) return bad(res, 400, "Montant de remboursement invalide (de 0 à 1 000 000)");
  } else if (mode !== "aucun") return bad(res, 400, "Remboursement inconnu (achat, revente, montant, aucun)");

  await prisma.$transaction(async (tx: any) => {
    // le fret en cours repart sur le marché, l'équipage descend, l'historique des incidents part avec la rame
    await tx.contract.updateMany({ where: { trainId: t.id, status: "EN_COURS" }, data: { status: "DISPONIBLE", trainId: null, companyId: null, acceptedAt: null, tourMinutes: null } });
    await tx.contract.updateMany({ where: { trainId: t.id }, data: { trainId: null } });
    await tx.staff.updateMany({ where: { trainId: t.id }, data: { trainId: null } });
    await tx.incident.deleteMany({ where: { trainId: t.id } });
    await tx.wreck.updateMany({ where: { trainId: t.id }, data: { trainId: null } });
    await tx.train.delete({ where: { id: t.id } });
    if (refund > 0) {
      await tx.company.update({ where: { id: c.id }, data: { balance: { increment: refund } } });
    }
    await tx.transaction.create({
      data: { companyId: c.id, type: "REMBOURSEMENT", amount: refund, description: `${t.name} retirée par ${GIFT_FROM}${refund > 0 ? ", remboursée" : ""} : ${reason}` },
    });
  });
  if (refund > 0) {
    void sendToCompany(c.id, {
      title: "Rame remboursée",
      body: `L'équipe de Réseau a retiré ${t.name} (${reason}) et vous rembourse ${fmt(refund)} pi.`,
      url: "/dashboard",
      tag: "cadeau",
    });
  }
  await logAdmin(actor(req), "RAME", { id: c.id, label: c.name }, `${t.name} (${t.model.toLowerCase()}) retirée, ${refund > 0 ? `remboursée ${fmt(refund)} pi.` : "sans remboursement"} — ${reason}`);
  res.json({ ok: true, refund });
}

/* ---------------- saisons et Grand Chantier ---------------- */

export async function seasons(_req: AuthRequest, res: Response) {
  const [list, cur, world] = await Promise.all([
    prisma.season.findMany({ orderBy: { number: "desc" }, take: 8 }),
    currentSeason(),
    ensureProject().catch(() => null),
  ]);
  let current = null;
  if (cur) {
    const entries = (await prisma.seasonEntry.findMany({
      where: { seasonId: cur.id },
      select: { companyId: true, division: true, groupNo: true, points: true },
      orderBy: { points: "desc" },
    })) as { companyId: string; division: number; groupNo: number; points: number }[];
    const names = new Map(
      ((await prisma.company.findMany({ where: { id: { in: entries.slice(0, 20).map((e) => e.companyId) } }, select: { id: true, name: true } })) as { id: string; name: string }[]).map((c) => [c.id, c.name])
    );
    const divisions = DIVISIONS.map((label, i) => {
      const inDiv = entries.filter((e) => e.division === i);
      return { label, companies: inDiv.length, groups: new Set(inDiv.map((e) => e.groupNo)).size, points: inDiv.reduce((s, e) => s + e.points, 0) };
    });
    current = {
      ...cur,
      entries: entries.length,
      ranked: entries.filter((e) => e.points > 0).length,
      divisions,
      top: entries.slice(0, 20).map((e) => ({ companyId: e.companyId, name: names.get(e.companyId) ?? "—", division: DIVISIONS[e.division], group: e.groupNo, points: e.points })),
    };
  }
  const contributors = world
    ? ((await prisma.worldContribution.findMany({ where: { projectId: world.id }, orderBy: { amount: "desc" }, take: 10 })) as { companyId: string; amount: number }[])
    : [];
  const cNames = new Map(
    ((await prisma.company.findMany({ where: { id: { in: contributors.map((c) => c.companyId) } }, select: { id: true, name: true } })) as { id: string; name: string }[]).map((c) => [c.id, c.name])
  );
  res.json({
    current,
    history: list,
    world: world ? { ...world, contributors: contributors.map((c) => ({ name: cNames.get(c.companyId) ?? "—", amount: c.amount })) } : null,
  });
}

export async function updateSeason(req: AuthRequest, res: Response) {
  const s = await prisma.season.findUnique({ where: { id: req.params.id } });
  if (!s) return bad(res, 404, "Saison introuvable");
  if (s.endedAt) return bad(res, 409, "Cette saison est déjà terminée");
  const data: { name?: string; endsAt?: Date } = {};
  const changes: string[] = [];
  if (req.body?.name !== undefined) {
    const name = str(req.body.name, 60);
    if (name.length < 2) return bad(res, 400, "Nom trop court");
    data.name = name;
    changes.push(`nom → « ${name} »`);
  }
  if (req.body?.endsAt !== undefined) {
    const d = new Date(String(req.body.endsAt));
    if (Number.isNaN(d.getTime())) return bad(res, 400, "Date invalide");
    if (d.getTime() <= s.startsAt.getTime()) return bad(res, 400, "La fin doit suivre le début de la saison");
    if (d.getTime() > s.startsAt.getTime() + 120 * DAY) return bad(res, 400, "120 jours au plus");
    data.endsAt = d;
    changes.push(`fin → ${d.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}${d.getTime() <= Date.now() ? " (clôture au prochain tour)" : ""}`);
  }
  if (!changes.length) return bad(res, 400, "Rien à modifier");
  await prisma.season.update({ where: { id: s.id }, data });
  invalidateSeason();
  await logAdmin(actor(req), "SAISON", { id: s.id, label: `Saison ${s.number}` }, changes.join(", "));
  res.json({ ok: true });
}

export async function updateWorld(req: AuthRequest, res: Response) {
  const w = await ensureProject();
  const data: { target?: number; progress?: number } = {};
  if (req.body?.target !== undefined) {
    const t = int(req.body.target);
    if (!(t >= 1 && t <= 100_000_000)) return bad(res, 400, "Objectif invalide");
    data.target = t;
  }
  if (req.body?.progress !== undefined) {
    const p = int(req.body.progress);
    if (!(p >= 0 && p <= 100_000_000)) return bad(res, 400, "Avancement invalide");
    data.progress = p;
  }
  if (!Object.keys(data).length) return bad(res, 400, "Rien à modifier");
  await prisma.worldProject.update({ where: { id: TUNNEL_ID }, data });
  await logAdmin(actor(req), "CHANTIER", { id: w.id, label: w.name }, Object.entries(data).map(([k, v]) => `${k === "target" ? "objectif" : "avancement"} → ${fmt(v)}`).join(", "));
  res.json({ ok: true });
}

/* ---------------- alliances ---------------- */

export async function listAlliances(_req: AuthRequest, res: Response) {
  const [alliances, members, ranking] = await Promise.all([
    prisma.alliance.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.allianceMember.findMany({ select: { allianceId: true, companyId: true, joinedAt: true } }),
    allianceRanking().catch(() => []),
  ]);
  const ids = [...new Set((members as { companyId: string }[]).map((m) => m.companyId))];
  const names = new Map(((await prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const rank = new Map((ranking as { id: string; rank: number; points: number }[]).map((r) => [r.id, r]));
  res.json({
    alliances: (alliances as any[]).map((a) => {
      const m = (members as { allianceId: string; companyId: string; joinedAt: Date }[]).filter((x) => x.allianceId === a.id);
      return {
        id: a.id, name: a.name, color: a.color, pitch: a.pitch, recruiting: a.recruiting, discordUrl: a.discordUrl, createdAt: a.createdAt,
        rank: rank.get(a.id)?.rank ?? null,
        points: rank.get(a.id)?.points ?? 0,
        members: m.map((x) => ({ companyId: x.companyId, name: names.get(x.companyId) ?? "—", founder: x.companyId === a.founderId, joinedAt: x.joinedAt })),
      };
    }),
  });
}

export async function updateAllianceAdmin(req: AuthRequest, res: Response) {
  const a = await prisma.alliance.findUnique({ where: { id: req.params.id } });
  if (!a) return bad(res, 404, "Alliance introuvable");
  const data: Record<string, unknown> = {};
  if (req.body?.name !== undefined) {
    const name = str(req.body.name, 32);
    if (name.length < 2) return bad(res, 400, "Nom trop court");
    const clash = await prisma.alliance.findFirst({ where: { name, id: { not: a.id } } });
    if (clash) return bad(res, 409, "Ce nom est déjà pris");
    data.name = name;
  }
  if (req.body?.pitch !== undefined) data.pitch = str(req.body.pitch, 200) || null;
  if (req.body?.recruiting !== undefined) data.recruiting = Boolean(req.body.recruiting);
  if (req.body?.discordUrl !== undefined) data.discordUrl = str(req.body.discordUrl, 200) || null;
  if (!Object.keys(data).length) return bad(res, 400, "Rien à modifier");
  await prisma.alliance.update({ where: { id: a.id }, data });
  invalidateAlliances();
  await logAdmin(actor(req), "ALLIANCE", { id: a.id, label: a.name }, Object.keys(data).join(", ") + " modifié(s)");
  res.json({ ok: true });
}

export async function kickFromAlliance(req: AuthRequest, res: Response) {
  const a = await prisma.alliance.findUnique({ where: { id: req.params.id } });
  if (!a) return bad(res, 404, "Alliance introuvable");
  const m = await prisma.allianceMember.findFirst({ where: { allianceId: a.id, companyId: req.params.companyId } });
  if (!m) return bad(res, 404, "Ce membre n'est pas dans l'alliance");
  await prisma.allianceMember.delete({ where: { id: m.id } });
  const left = (await prisma.allianceMember.findMany({ where: { allianceId: a.id }, orderBy: { joinedAt: "asc" } })) as { companyId: string }[];
  if (!left.length) await dissolve(a.id);
  else if (a.founderId === m.companyId) await prisma.alliance.update({ where: { id: a.id }, data: { founderId: left[0].companyId } });
  invalidateAlliances();
  void syncCompany(m.companyId).catch(() => undefined);
  if (left.length && a.founderId === m.companyId) void syncCompany(left[0].companyId).catch(() => undefined);
  const name = (await prisma.company.findUnique({ where: { id: m.companyId }, select: { name: true } }))?.name ?? "?";
  await logAdmin(actor(req), "ALLIANCE", { id: a.id, label: a.name }, `${name} exclue${left.length ? "" : " (alliance dissoute, plus aucun membre)"}`);
  res.json({ ok: true });
}

async function dissolve(allianceId: string) {
  await prisma.$transaction([
    prisma.allianceMember.deleteMany({ where: { allianceId } }),
    prisma.allianceInvite.deleteMany({ where: { allianceId } }),
    prisma.allianceApplication.deleteMany({ where: { allianceId } }),
    prisma.allianceMessage.deleteMany({ where: { allianceId } }),
    prisma.alliance.delete({ where: { id: allianceId } }),
  ]);
}

export async function dissolveAlliance(req: AuthRequest, res: Response) {
  const a = await prisma.alliance.findUnique({ where: { id: req.params.id } });
  if (!a) return bad(res, 404, "Alliance introuvable");
  const members = (await prisma.allianceMember.findMany({ where: { allianceId: a.id }, select: { companyId: true } })) as { companyId: string }[];
  await dissolve(a.id);
  invalidateAlliances();
  for (const m of members) void syncCompany(m.companyId).catch(() => undefined);
  await logAdmin(actor(req), "ALLIANCE", { id: a.id, label: a.name }, `alliance dissoute (${members.length} membre${members.length > 1 ? "s" : ""})`);
  res.json({ ok: true });
}

/* ---------------- boutique ---------------- */

export async function shop(_req: AuthRequest, res: Response) {
  const [sales, gifts] = await Promise.all([
    prisma.shopPurchase.groupBy({ by: ["itemId"], where: { amountCents: { gt: 0 } }, _count: { _all: true }, _sum: { amountCents: true } }),
    prisma.shopPurchase.groupBy({ by: ["itemId"], where: { amountCents: 0 }, _count: { _all: true } }),
  ]);
  const sold = new Map((sales as any[]).map((s) => [s.itemId, { count: s._count._all, cents: s._sum.amountCents ?? 0 }]));
  const given = new Map((gifts as any[]).map((g) => [g.itemId, g._count._all]));
  const view = (i: { id: string; kind: string; name: string; description: string; priceCents: number; season?: string; isNew?: boolean }, exclusive = false) => ({
    id: i.id, kind: i.kind, name: i.name, description: i.description, priceCents: i.priceCents, season: i.season ?? null, isNew: Boolean(i.isNew), exclusive,
    sold: sold.get(i.id)?.count ?? 0,
    revenueCents: sold.get(i.id)?.cents ?? 0,
    gifted: given.get(i.id) ?? 0,
  });
  const items = [...SHOP_ITEMS.map((i) => view(i)), view(AD_FREE_ITEM), ...DISCORD_ITEMS.map((i) => view(i, true))];
  // les pass de saison n'ont pas d'entrée fixe au catalogue
  for (const [id, s] of sold) if (!items.some((i) => i.id === id)) items.push({ id, kind: "PASS", name: findAnyItem(id)?.name ?? id, description: "", priceCents: 0, season: null, isNew: false, exclusive: false, sold: s.count, revenueCents: s.cents, gifted: given.get(id) ?? 0 });
  res.json({ items });
}

/* ---------------- giveaways ---------------- */

export async function listGiveaways(_req: AuthRequest, res: Response) {
  const list = (await prisma.giveaway.findMany({ orderBy: { createdAt: "desc" }, take: 30 })) as any[];
  const counts = await prisma.giveawayEntry.groupBy({ by: ["giveawayId"], where: { giveawayId: { in: list.map((g) => g.id) } }, _count: { _all: true } });
  const n = new Map((counts as any[]).map((c) => [c.giveawayId, c._count._all]));
  res.json({
    bot: botEnabled(),
    prizes: PRIZE_CHOICES,
    maxCoins: MAX_GIFT_COINS,
    maxTrialDays: MAX_TRIAL_DAYS,
    maxWinners: MAX_WINNERS,
    giveaways: list.map((g) => ({
      id: g.id,
      prize: prizeLabel(g.prizeKind === "pieces" ? { kind: "pieces", amount: Number(g.prizeValue) } : g.prizeKind === "essai" ? { kind: "essai", days: Number(g.prizeValue) } : { kind: "objet", itemId: g.prizeValue }),
      winners: g.winners,
      endsAt: g.endsAt,
      endedAt: g.endedAt,
      participants: n.get(g.id) ?? 0,
      winnerIds: g.winnerIds,
    })),
  });
}

const CHANNEL_KEYS = Object.keys(CHANNELS) as ChannelKey[];

export async function launchGiveaway(req: AuthRequest, res: Response) {
  if (!botEnabled()) return bad(res, 503, "Le bot Discord n'est pas configuré (DISCORD_BOT_TOKEN, DISCORD_GUILD_ID)");
  const prize = parsePrize(str(req.body?.lot, 80), int(req.body?.amount), int(req.body?.days));
  if (typeof prize === "string") return bad(res, 400, prize);
  const winners = int(req.body?.winners) || 1;
  if (winners < 1 || winners > MAX_WINNERS) return bad(res, 400, `De 1 à ${MAX_WINNERS} gagnants`);
  const durationMs = parseDuration(str(req.body?.duration, 30));
  if (!durationMs || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) return bad(res, 400, "Durée invalide (ex. 48h, 2j, 1j12h — de 5 minutes à 30 jours)");
  const key = (CHANNEL_KEYS.includes(req.body?.channel) ? req.body.channel : "ANNONCES") as ChannelKey;
  const channel = await channelId(key);
  if (!channel) return bad(res, 409, `Salon « ${CHANNELS[key]} » introuvable sur le serveur`);
  const me = await prisma.user.findUnique({ where: { id: req.admin!.id }, select: { discordId: true } });
  const g = await createGiveaway({ channelId: channel, prize, winners, durationMs, createdBy: me?.discordId ?? "panneau" });
  await logAdmin(actor(req), "GIVEAWAY", { id: g.id, label: prizeLabel(prize) }, `${winners} gagnant${winners > 1 ? "s" : ""}, dans ${CHANNELS[key]}`);
  res.json({ ok: true, id: g.id });
}

export async function endGiveaway(req: AuthRequest, res: Response) {
  const done = await finishGiveaway(req.params.id);
  if (!done) return bad(res, 409, "Giveaway déjà terminé ou introuvable");
  await logAdmin(actor(req), "GIVEAWAY", { id: req.params.id, label: req.params.id.slice(0, 8) }, "tirage anticipé");
  res.json({ ok: true });
}

export async function rerollGiveawayAdmin(req: AuthRequest, res: Response) {
  const msg = await rerollGiveaway(req.params.id);
  await logAdmin(actor(req), "GIVEAWAY", { id: req.params.id, label: req.params.id.slice(0, 8) }, `nouveau tirage : ${msg}`);
  res.json({ ok: true, message: msg.replace(/<@(\d+)>/g, "@$1") });
}

/* ---------------- annonces ---------------- */

const ANNOUNCE_CHANNELS: ChannelKey[] = ["ANNONCES", "PATCH_NOTES", "SAISONS", "CHANTIER"];

export async function listAnnouncements(_req: AuthRequest, res: Response) {
  const list = await prisma.announcement.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
  res.json({
    bot: botEnabled(),
    push: pushEnabled(),
    channels: ANNOUNCE_CHANNELS.map((k) => ({ key: k, label: CHANNELS[k] })),
    pings: Object.entries(NOTIFY_ROLES).map(([k, v]) => ({ key: k, label: v })),
    announcements: list,
  });
}

export async function createAnnouncement(req: AuthRequest, res: Response) {
  const title = str(req.body?.title, 200);
  const body = str(req.body?.body, 3800);
  const imageUrl = str(req.body?.imageUrl, 500) || null;
  const igCaption = str(req.body?.igCaption, 2200);
  const channel = (ANNOUNCE_CHANNELS.includes(req.body?.channel) ? req.body.channel : "ANNONCES") as ChannelKey;
  const ping = (req.body?.ping && req.body.ping in NOTIFY_ROLES ? req.body.ping : null) as NotifyRole | null;
  const toDiscord = req.body?.discord !== false;
  const toPush = req.body?.push === true;
  if (title.length < 2) return bad(res, 400, "Titre trop court");
  if (body.length < 2) return bad(res, 400, "Texte trop court");
  if (imageUrl && !/^https:\/\/\S+$/i.test(imageUrl)) return bad(res, 400, "L'image doit être une adresse https://");
  // le visuel fabriqué dans le panneau, joint au message Discord
  let file: DiscordFile | undefined;
  const dataUrl = String(req.body?.imageData ?? "");
  if (dataUrl) {
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return bad(res, 400, "Visuel illisible (PNG ou JPEG attendu)");
    const data = Buffer.from(m[2], "base64");
    if (data.length > 7_500_000) return bad(res, 400, "Visuel trop lourd (7 Mo au plus)");
    file = { name: `reseau-annonce.${m[1] === "png" ? "png" : "jpg"}`, data, type: `image/${m[1]}` };
  }
  if (toDiscord && !botEnabled()) return bad(res, 503, "Le bot Discord n'est pas configuré (DISCORD_BOT_TOKEN, DISCORD_GUILD_ID)");

  const a = await prisma.announcement.create({
    data: { title, body, imageUrl, channel, ping, igCaption, createdBy: req.admin!.name },
  });

  if (toDiscord) {
    const key = `annonce:${a.id}`;
    try {
      const posted = await postOnce(
        key,
        channel,
        [
          {
            embeds: [
              {
                title,
                description: body,
                url: process.env.PUBLIC_SITE_URL || undefined,
                color: BRAND_COLOR,
                ...(file ? { image: { url: `attachment://${file.name}` } } : imageUrl ? { image: { url: imageUrl } } : {}),
                footer: { text: "L'équipe de Réseau" },
                timestamp: new Date().toISOString(),
              },
            ],
          },
        ],
        { crosspost: channel === "ANNONCES", ...(ping ? { ping } : {}), ...(file ? { file } : {}) }
      );
      if (!posted) {
        await prisma.announcement.delete({ where: { id: a.id } });
        return bad(res, 409, `Salon « ${CHANNELS[channel]} » introuvable sur le serveur`);
      }
      await prisma.announcement.update({ where: { id: a.id }, data: { discordKey: key } });
    } catch (err) {
      await prisma.announcement.delete({ where: { id: a.id } }).catch(() => undefined);
      console.error("[admin] annonce Discord :", (err as Error).message);
      return bad(res, 502, "Discord a refusé le message (droits du bot sur le salon ?)");
    }
  }

  let pushTargets = 0;
  if (toPush && pushEnabled()) {
    const subs = (await prisma.pushSubscription.findMany({ distinct: ["companyId"], select: { companyId: true } })) as { companyId: string }[];
    pushTargets = subs.length;
    // en arrière-plan : quelques centaines d'envois, la réponse n'attend pas
    void (async () => {
      let sent = 0;
      for (const s of subs) {
        const r = await sendToCompany(s.companyId, { title, body: body.replace(/[*_`>#~|]/g, "").slice(0, 180), url: "/dashboard", tag: `annonce-${a.id.slice(0, 8)}` }).catch(() => null);
        if (r && r.delivered > 0) sent++;
      }
      await prisma.announcement.update({ where: { id: a.id }, data: { pushSent: sent } }).catch(() => undefined);
    })();
  }

  await logAdmin(actor(req), "ANNONCE", { id: a.id, label: title }, [toDiscord ? `Discord ${CHANNELS[channel]}${ping ? ` + ${NOTIFY_ROLES[ping]}` : ""}` : null, toPush ? `push vers ${pushTargets} compagnies` : null].filter(Boolean).join(", ") || "brouillon Instagram");
  res.json({ ok: true, id: a.id, pushTargets });
}

/* ---------------- journal ---------------- */

export async function adminLogs(req: AuthRequest, res: Response) {
  const page = Math.max(0, int(req.query.page) || 0);
  const action = str(req.query.action, 20);
  const where = action ? { action } : {};
  const [total, rows] = await Promise.all([
    prisma.adminAction.count({ where }),
    prisma.adminAction.findMany({ where, orderBy: { createdAt: "desc" }, skip: page * 50, take: 50 }),
  ]);
  res.json({ total, page, pageSize: 50, logs: rows });
}
