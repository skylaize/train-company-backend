import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import {
  TRADED_CARGO,
  buyPrice,
  sellPrice,
  ensureCargoMarkets,
  parseHistory,
  STORAGE_FEE_RATE_PER_HOUR,
  INDEX_MIN,
  INDEX_MAX,
} from "../services/market.service";
import { STOCK_TYPES_FREE, STOCK_TYPES_PREMIUM } from "../services/construction.service";
import { sendToCompany } from "../services/push.service";

async function companyOf(req: AuthRequest) {
  return prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true, balance: true, isPremium: true },
  });
}

/* Variation sur la dernière heure, calculée depuis l'historique. C'est le
   chiffre que le joueur lit réellement : l'indice absolu ne dit rien, la
   pente dit tout. */
function trendOverHour(history: { t: number; i: number }[], current: number) {
  const hourAgo = Date.now() - 3600_000;
  const past = history.filter((p) => p.t >= hourAgo);
  const reference = past.length > 0 ? past[0].i : history[0]?.i ?? current;
  if (!reference) return 0;
  return (current - reference) / reference;
}

export async function getMarketPrices(req: AuthRequest, res: Response) {
  await ensureCargoMarkets();

  const company = await companyOf(req);
  const markets = await prisma.cargoMarket.findMany();

  const stock = company
    ? await prisma.stockLot.findMany({ where: { companyId: company.id } })
    : [];
  const stockByType = new Map<string, { quantity: number; avgUnitPrice: number }>(
    (stock as { cargoType: string; quantity: number; avgUnitPrice: number }[]).map((s) => [
      s.cargoType,
      { quantity: s.quantity, avgUnitPrice: s.avgUnitPrice },
    ])
  );

  const rows = (markets as any[])
    .map((m) => {
      const history = parseHistory(m.history);
      const held = stockByType.get(m.cargoType);
      const unitSell = sellPrice(m.basePrice, m.index);

      return {
        cargoType: m.cargoType,
        basePrice: m.basePrice,
        index: Number(m.index.toFixed(4)),
        buyPrice: buyPrice(m.basePrice, m.index),
        sellPrice: unitSell,
        trendHour: Number(trendOverHour(history, m.index).toFixed(4)),
        history: history.map((p) => ({ t: p.t, i: p.i })),
        eventLabel: m.eventUntil && new Date(m.eventUntil).getTime() > Date.now() ? m.eventLabel : null,
        held: held
          ? {
              quantity: held.quantity,
              avgUnitPrice: Number(held.avgUnitPrice.toFixed(2)),
              // plus-value latente : ce que le lot rapporterait s'il était vendu maintenant
              unrealized: Math.round((unitSell - held.avgUnitPrice) * held.quantity),
            }
          : null,
      };
    })
    .sort((a, b) => a.cargoType.localeCompare(b.cargoType, "fr"));

  const warehouse = company ? await prisma.warehouse.findUnique({ where: { companyId: company.id } }) : null;
  const stored = (stock as { quantity: number }[]).reduce((sum, s) => sum + s.quantity, 0);
  const storedValue = (stock as { quantity: number; avgUnitPrice: number }[]).reduce(
    (sum, s) => sum + s.quantity * s.avgUnitPrice,
    0
  );

  return res.json({
    cargos: rows,
    indexMin: INDEX_MIN,
    indexMax: INDEX_MAX,
    warehouse: warehouse
      ? {
          capacity: warehouse.capacity,
          level: warehouse.level,
          stored,
          free: Math.max(0, warehouse.capacity - stored),
          maxTypes: company?.isPremium ? STOCK_TYPES_PREMIUM : STOCK_TYPES_FREE,
          typesUsed: stock.length,
          storageFeeRatePerHour: STORAGE_FEE_RATE_PER_HOUR,
          // valeur immobilisée, pour afficher la facture horaire réelle
          storedValue: Math.round(storedValue),
        }
      : null,
    balance: company?.balance ?? 0,
    isPremium: company?.isPremium ?? false,
  });
}

/* Achat. Le prix est relu en base au moment de l'opération : un prix envoyé
   par le navigateur serait un prix choisi par le joueur. */
export async function buyCargo(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const { cargoType } = req.body;
  const quantity = Number(req.body.quantity);

  if (!TRADED_CARGO.some((c) => c.cargoType === cargoType)) {
    return res.status(400).json({ error: "Cette marchandise n'est pas cotée" });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
    return res.status(400).json({ error: "Quantité invalide" });
  }

  const result = await executeBuy(company.id, cargoType, quantity, company.isPremium);
  if ("error" in result) return res.status(409).json({ error: result.error });
  return res.json(result);
}

export async function executeBuy(
  companyId: string,
  cargoType: string,
  quantity: number,
  isPremium: boolean
): Promise<{ error: string } | { quantity: number; unitPrice: number; total: number }> {
  const warehouse = await prisma.warehouse.findUnique({ where: { companyId } });
  if (!warehouse) return { error: "Construisez d'abord un entrepôt" };

  const market = await prisma.cargoMarket.findUnique({ where: { cargoType } });
  if (!market) return { error: "Cette marchandise n'est pas cotée" };

  const lots = await prisma.stockLot.findMany({ where: { companyId } });
  const stored = (lots as { quantity: number }[]).reduce((sum, l) => sum + l.quantity, 0);
  if (stored + quantity > warehouse.capacity) {
    return { error: `L'entrepôt ne peut accueillir que ${warehouse.capacity - stored} unité(s) de plus` };
  }

  const existing = (lots as { cargoType: string; quantity: number; avgUnitPrice: number }[]).find(
    (l) => l.cargoType === cargoType
  );
  const maxTypes = isPremium ? STOCK_TYPES_PREMIUM : STOCK_TYPES_FREE;
  if (!existing && lots.length >= maxTypes) {
    return {
      error: `Vous ne pouvez stocker que ${maxTypes} marchandises différentes à la fois`,
    };
  }

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { balance: true } });
  if (!company) return { error: "Compagnie introuvable" };

  const unitPrice = buyPrice(market.basePrice, market.index);
  const total = unitPrice * quantity;
  if (company.balance < total) {
    return { error: `Trésorerie insuffisante (${total} pièces nécessaires)` };
  }

  /* Prix de revient moyen pondéré : deux achats à des cours différents donnent
     un seul lot, sinon il faudrait suivre chaque achat séparément pour un
     bénéfice de lisibilité nul. */
  const newQuantity = (existing?.quantity ?? 0) + quantity;
  const newAvg = existing
    ? (existing.avgUnitPrice * existing.quantity + total) / newQuantity
    : unitPrice;

  await prisma.$transaction([
    prisma.company.update({ where: { id: companyId }, data: { balance: { decrement: total } } }),
    prisma.stockLot.upsert({
      where: { companyId_cargoType: { companyId, cargoType } },
      update: { quantity: newQuantity, avgUnitPrice: newAvg },
      create: { companyId, cargoType, quantity, avgUnitPrice: unitPrice },
    }),
    prisma.transaction.create({
      data: {
        companyId,
        type: "ACHAT_FRET",
        amount: -total,
        description: `Achat de ${quantity} × ${cargoType} à ${unitPrice} pi.`,
      },
    }),
  ]);

  return { quantity, unitPrice, total };
}

export async function sellCargo(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const { cargoType } = req.body;
  const quantity = Number(req.body.quantity);

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
    return res.status(400).json({ error: "Quantité invalide" });
  }

  const result = await executeSell(company.id, cargoType, quantity);
  if ("error" in result) return res.status(409).json({ error: result.error });
  return res.json(result);
}

export async function executeSell(
  companyId: string,
  cargoType: string,
  quantity: number
): Promise<{ error: string } | { quantity: number; unitPrice: number; total: number; gain: number }> {
  const lot = await prisma.stockLot.findUnique({
    where: { companyId_cargoType: { companyId, cargoType } },
  });
  if (!lot || lot.quantity < quantity) {
    return { error: "Vous n'avez pas cette quantité en stock" };
  }

  const market = await prisma.cargoMarket.findUnique({ where: { cargoType } });
  if (!market) return { error: "Cette marchandise n'est pas cotée" };

  const unitPrice = sellPrice(market.basePrice, market.index);
  const total = unitPrice * quantity;
  const gain = Math.round((unitPrice - lot.avgUnitPrice) * quantity);
  const remaining = lot.quantity - quantity;

  await prisma.$transaction([
    prisma.company.update({ where: { id: companyId }, data: { balance: { increment: total } } }),
    remaining > 0
      ? prisma.stockLot.update({
          where: { companyId_cargoType: { companyId, cargoType } },
          // le prix de revient moyen ne bouge pas à la vente : on solde une part du lot
          data: { quantity: remaining },
        })
      : prisma.stockLot.delete({ where: { companyId_cargoType: { companyId, cargoType } } }),
    prisma.transaction.create({
      data: {
        companyId,
        type: "VENTE_FRET",
        amount: total,
        description: `Vente de ${quantity} × ${cargoType} à ${unitPrice} pi. (${gain >= 0 ? "+" : ""}${gain} pi.)`,
      },
    }),
  ]);

  return { quantity, unitPrice, total, gain };
}

/* ============================================================
   Alertes et ordres permanents — réservés aux abonnés.

   Ni l'un ni l'autre n'améliore le prix obtenu : ils remplacent la PRÉSENCE.
   Un joueur gratuit qui surveille son écran obtient exactement le même cours.
   ============================================================ */

const MAX_ALERTS = 8;
const MAX_ORDERS = 6;

export async function listAlerts(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const [alerts, orders] = await Promise.all([
    prisma.priceAlert.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } }),
    prisma.standingOrder.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } }),
  ]);

  return res.json({ alerts, orders, isPremium: company.isPremium });
}

export async function createAlert(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  if (!company.isPremium) {
    return res.status(403).json({ error: "Les alertes de cours sont réservées aux compagnies Premium" });
  }

  const { cargoType, direction } = req.body;
  const threshold = Number(req.body.threshold);

  if (!TRADED_CARGO.some((c) => c.cargoType === cargoType)) {
    return res.status(400).json({ error: "Cette marchandise n'est pas cotée" });
  }
  if (direction !== "DESSOUS" && direction !== "DESSUS") {
    return res.status(400).json({ error: "Sens d'alerte invalide" });
  }
  if (!Number.isFinite(threshold) || threshold < INDEX_MIN || threshold > INDEX_MAX) {
    return res.status(400).json({ error: "Seuil hors des bornes du cours" });
  }

  const count = await prisma.priceAlert.count({ where: { companyId: company.id } });
  if (count >= MAX_ALERTS) {
    return res.status(409).json({ error: `Vous ne pouvez pas suivre plus de ${MAX_ALERTS} alertes` });
  }

  const alert = await prisma.priceAlert.create({
    data: { companyId: company.id, cargoType, direction, threshold },
  });
  return res.status(201).json(alert);
}

export async function deleteAlert(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  await prisma.priceAlert.deleteMany({ where: { id: req.params.id, companyId: company.id } });
  return res.json({ ok: true });
}

/* Marque les alertes déclenchées comme lues. L'interface le fait après avoir
   affiché le message, pour ne pas le répéter à chaque rechargement. */
export async function acknowledgeAlerts(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  await prisma.priceAlert.updateMany({
    where: { companyId: company.id, triggeredAt: { not: null }, seen: false },
    data: { seen: true },
  });
  return res.json({ ok: true });
}

export async function createStandingOrder(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  if (!company.isPremium) {
    return res.status(403).json({ error: "Les ordres permanents sont réservés aux compagnies Premium" });
  }

  const { cargoType, kind } = req.body;
  const threshold = Number(req.body.threshold);
  const quantity = Number(req.body.quantity);

  if (!TRADED_CARGO.some((c) => c.cargoType === cargoType)) {
    return res.status(400).json({ error: "Cette marchandise n'est pas cotée" });
  }
  if (kind !== "ACHAT" && kind !== "VENTE") {
    return res.status(400).json({ error: "Type d'ordre invalide" });
  }
  if (!Number.isFinite(threshold) || threshold < INDEX_MIN || threshold > INDEX_MAX) {
    return res.status(400).json({ error: "Seuil hors des bornes du cours" });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return res.status(400).json({ error: "Quantité invalide" });
  }

  const count = await prisma.standingOrder.count({ where: { companyId: company.id } });
  if (count >= MAX_ORDERS) {
    return res.status(409).json({ error: `Vous ne pouvez pas tenir plus de ${MAX_ORDERS} ordres permanents` });
  }

  const order = await prisma.standingOrder.create({
    data: { companyId: company.id, cargoType, kind, threshold, quantity },
  });
  return res.status(201).json(order);
}

export async function deleteStandingOrder(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  await prisma.standingOrder.deleteMany({ where: { id: req.params.id, companyId: company.id } });
  return res.json({ ok: true });
}

/* ============================================================
   Exécution automatique — appelée par le tick de simulation.
   ============================================================ */

/* Alertes : on ne déclenche qu'une fois. Une alerte qui se redéclencherait à
   chaque tick tant que le cours reste sous le seuil noierait le joueur. */
export async function checkPriceAlerts() {
  const alerts = await prisma.priceAlert.findMany({ where: { triggeredAt: null } });
  if (alerts.length === 0) return;

  const markets = await prisma.cargoMarket.findMany();
  const indexByType = new Map<string, number>(
    (markets as { cargoType: string; index: number }[]).map((m) => [m.cargoType, m.index])
  );

  for (const alert of alerts as {
    id: string; companyId: string; cargoType: string; direction: string; threshold: number;
  }[]) {
    const index = indexByType.get(alert.cargoType);
    if (index === undefined) continue;

    const hit =
      alert.direction === "DESSOUS" ? index <= alert.threshold : index >= alert.threshold;
    if (!hit) continue;

    await prisma.priceAlert.update({
      where: { id: alert.id },
      data: { triggeredAt: new Date(), seen: false },
    });

    /* C'est ici que l'alerte prend tout son sens : elle part vers l'appareil du
       joueur, qu'il soit sur le jeu ou non. Sans cet envoi, elle n'apparaissait
       qu'à condition d'avoir déjà la page des cours ouverte — donc à celui qui
       n'en avait pas besoin. */
    await sendToCompany(alert.companyId, {
      title: `${alert.cargoType} — seuil franchi`,
      body: `Le cours est passé ${alert.direction === "DESSOUS" ? "sous" : "au-dessus de"} ${Math.round(
        alert.threshold * 100
      )}.`,
      url: "/dashboard",
      tag: `alerte-${alert.cargoType}`,
    });
  }
}

/* Ordres permanents. Un ordre ne s'exécute qu'une fois par franchissement :
   tant que le cours reste du même côté du seuil, il ne repart pas. Le champ
   lastRunAt sert de garde-fou de temps, la désactivation de garde-fou de
   répétition. */
const ORDER_COOLDOWN_MS = 15 * 60_000;

export async function runStandingOrders() {
  const orders = await prisma.standingOrder.findMany({ where: { active: true } });
  if (orders.length === 0) return;

  const markets = await prisma.cargoMarket.findMany();
  const indexByType = new Map<string, number>(
    (markets as { cargoType: string; index: number }[]).map((m) => [m.cargoType, m.index])
  );

  for (const order of orders as {
    id: string; companyId: string; cargoType: string; kind: string;
    threshold: number; quantity: number; lastRunAt: Date | null;
  }[]) {
    const index = indexByType.get(order.cargoType);
    if (index === undefined) continue;
    if (order.lastRunAt && Date.now() - new Date(order.lastRunAt).getTime() < ORDER_COOLDOWN_MS) continue;

    const hit = order.kind === "ACHAT" ? index <= order.threshold : index >= order.threshold;
    if (!hit) continue;

    /* On revérifie l'abonnement au moment d'exécuter : un ordre créé pendant
       l'abonnement ne doit pas continuer à tourner après son expiration. */
    const company = await prisma.company.findUnique({
      where: { id: order.companyId },
      select: { isPremium: true },
    });
    if (!company?.isPremium) continue;

    const result =
      order.kind === "ACHAT"
        ? await executeBuy(order.companyId, order.cargoType, order.quantity, true)
        : await executeSell(order.companyId, order.cargoType, order.quantity);

    /* Échec (entrepôt plein, trésorerie insuffisante, stock absent) : l'ordre
       est simplement mis en sommeil jusqu'au prochain créneau, sans message
       d'erreur nulle part — il réessaiera. */
    if (!("error" in result)) {
      await sendToCompany(order.companyId, {
        title: order.kind === "ACHAT" ? "Ordre d'achat exécuté" : "Ordre de vente exécuté",
        body:
          order.kind === "ACHAT"
            ? `${result.quantity} × ${order.cargoType} acheté au cours du moment (${result.total} pi.).`
            : `${result.quantity} × ${order.cargoType} vendu (${result.total} pi.).`,
        url: "/dashboard",
        tag: `ordre-${order.cargoType}`,
      });
    }

    await prisma.standingOrder.update({
      where: { id: order.id },
      data: { lastRunAt: new Date() },
    });
  }
}
