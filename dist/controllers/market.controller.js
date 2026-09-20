"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMarketPrices = getMarketPrices;
exports.buyCargo = buyCargo;
exports.executeBuy = executeBuy;
exports.sellCargo = sellCargo;
exports.executeSell = executeSell;
exports.listAlerts = listAlerts;
exports.createAlert = createAlert;
exports.deleteAlert = deleteAlert;
exports.acknowledgeAlerts = acknowledgeAlerts;
exports.createStandingOrder = createStandingOrder;
exports.deleteStandingOrder = deleteStandingOrder;
exports.checkPriceAlerts = checkPriceAlerts;
exports.runStandingOrders = runStandingOrders;
const prisma_1 = require("../prisma");
const market_service_1 = require("../services/market.service");
const construction_service_1 = require("../services/construction.service");
async function companyOf(req) {
    return prisma_1.prisma.company.findUnique({
        where: { ownerId: req.userId },
        select: { id: true, balance: true, isPremium: true },
    });
}
/* Variation sur la dernière heure, calculée depuis l'historique. C'est le
   chiffre que le joueur lit réellement : l'indice absolu ne dit rien, la
   pente dit tout. */
function trendOverHour(history, current) {
    const hourAgo = Date.now() - 3600000;
    const past = history.filter((p) => p.t >= hourAgo);
    const reference = past.length > 0 ? past[0].i : history[0]?.i ?? current;
    if (!reference)
        return 0;
    return (current - reference) / reference;
}
async function getMarketPrices(req, res) {
    await (0, market_service_1.ensureCargoMarkets)();
    const company = await companyOf(req);
    const markets = await prisma_1.prisma.cargoMarket.findMany();
    const stock = company
        ? await prisma_1.prisma.stockLot.findMany({ where: { companyId: company.id } })
        : [];
    const stockByType = new Map(stock.map((s) => [
        s.cargoType,
        { quantity: s.quantity, avgUnitPrice: s.avgUnitPrice },
    ]));
    const rows = markets
        .map((m) => {
        const history = (0, market_service_1.parseHistory)(m.history);
        const held = stockByType.get(m.cargoType);
        const unitSell = (0, market_service_1.sellPrice)(m.basePrice, m.index);
        return {
            cargoType: m.cargoType,
            basePrice: m.basePrice,
            index: Number(m.index.toFixed(4)),
            buyPrice: (0, market_service_1.buyPrice)(m.basePrice, m.index),
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
    const warehouse = company ? await prisma_1.prisma.warehouse.findUnique({ where: { companyId: company.id } }) : null;
    const stored = stock.reduce((sum, s) => sum + s.quantity, 0);
    const storedValue = stock.reduce((sum, s) => sum + s.quantity * s.avgUnitPrice, 0);
    return res.json({
        cargos: rows,
        indexMin: market_service_1.INDEX_MIN,
        indexMax: market_service_1.INDEX_MAX,
        warehouse: warehouse
            ? {
                capacity: warehouse.capacity,
                level: warehouse.level,
                stored,
                free: Math.max(0, warehouse.capacity - stored),
                maxTypes: company?.isPremium ? construction_service_1.STOCK_TYPES_PREMIUM : construction_service_1.STOCK_TYPES_FREE,
                typesUsed: stock.length,
                storageFeeRatePerHour: market_service_1.STORAGE_FEE_RATE_PER_HOUR,
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
async function buyCargo(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    const { cargoType } = req.body;
    const quantity = Number(req.body.quantity);
    if (!market_service_1.TRADED_CARGO.some((c) => c.cargoType === cargoType)) {
        return res.status(400).json({ error: "Cette marchandise n'est pas cotée" });
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
        return res.status(400).json({ error: "Quantité invalide" });
    }
    const result = await executeBuy(company.id, cargoType, quantity, company.isPremium);
    if ("error" in result)
        return res.status(409).json({ error: result.error });
    return res.json(result);
}
async function executeBuy(companyId, cargoType, quantity, isPremium) {
    const warehouse = await prisma_1.prisma.warehouse.findUnique({ where: { companyId } });
    if (!warehouse)
        return { error: "Construisez d'abord un entrepôt" };
    const market = await prisma_1.prisma.cargoMarket.findUnique({ where: { cargoType } });
    if (!market)
        return { error: "Cette marchandise n'est pas cotée" };
    const lots = await prisma_1.prisma.stockLot.findMany({ where: { companyId } });
    const stored = lots.reduce((sum, l) => sum + l.quantity, 0);
    if (stored + quantity > warehouse.capacity) {
        return { error: `L'entrepôt ne peut accueillir que ${warehouse.capacity - stored} unité(s) de plus` };
    }
    const existing = lots.find((l) => l.cargoType === cargoType);
    const maxTypes = isPremium ? construction_service_1.STOCK_TYPES_PREMIUM : construction_service_1.STOCK_TYPES_FREE;
    if (!existing && lots.length >= maxTypes) {
        return {
            error: `Vous ne pouvez stocker que ${maxTypes} marchandises différentes à la fois`,
        };
    }
    const company = await prisma_1.prisma.company.findUnique({ where: { id: companyId }, select: { balance: true } });
    if (!company)
        return { error: "Compagnie introuvable" };
    const unitPrice = (0, market_service_1.buyPrice)(market.basePrice, market.index);
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
    await prisma_1.prisma.$transaction([
        prisma_1.prisma.company.update({ where: { id: companyId }, data: { balance: { decrement: total } } }),
        prisma_1.prisma.stockLot.upsert({
            where: { companyId_cargoType: { companyId, cargoType } },
            update: { quantity: newQuantity, avgUnitPrice: newAvg },
            create: { companyId, cargoType, quantity, avgUnitPrice: unitPrice },
        }),
        prisma_1.prisma.transaction.create({
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
async function sellCargo(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    const { cargoType } = req.body;
    const quantity = Number(req.body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
        return res.status(400).json({ error: "Quantité invalide" });
    }
    const result = await executeSell(company.id, cargoType, quantity);
    if ("error" in result)
        return res.status(409).json({ error: result.error });
    return res.json(result);
}
async function executeSell(companyId, cargoType, quantity) {
    const lot = await prisma_1.prisma.stockLot.findUnique({
        where: { companyId_cargoType: { companyId, cargoType } },
    });
    if (!lot || lot.quantity < quantity) {
        return { error: "Vous n'avez pas cette quantité en stock" };
    }
    const market = await prisma_1.prisma.cargoMarket.findUnique({ where: { cargoType } });
    if (!market)
        return { error: "Cette marchandise n'est pas cotée" };
    const unitPrice = (0, market_service_1.sellPrice)(market.basePrice, market.index);
    const total = unitPrice * quantity;
    const gain = Math.round((unitPrice - lot.avgUnitPrice) * quantity);
    const remaining = lot.quantity - quantity;
    await prisma_1.prisma.$transaction([
        prisma_1.prisma.company.update({ where: { id: companyId }, data: { balance: { increment: total } } }),
        remaining > 0
            ? prisma_1.prisma.stockLot.update({
                where: { companyId_cargoType: { companyId, cargoType } },
                // le prix de revient moyen ne bouge pas à la vente : on solde une part du lot
                data: { quantity: remaining },
            })
            : prisma_1.prisma.stockLot.delete({ where: { companyId_cargoType: { companyId, cargoType } } }),
        prisma_1.prisma.transaction.create({
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
async function listAlerts(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    const [alerts, orders] = await Promise.all([
        prisma_1.prisma.priceAlert.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } }),
        prisma_1.prisma.standingOrder.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } }),
    ]);
    return res.json({ alerts, orders, isPremium: company.isPremium });
}
async function createAlert(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    if (!company.isPremium) {
        return res.status(403).json({ error: "Les alertes de cours sont réservées aux compagnies Premium" });
    }
    const { cargoType, direction } = req.body;
    const threshold = Number(req.body.threshold);
    if (!market_service_1.TRADED_CARGO.some((c) => c.cargoType === cargoType)) {
        return res.status(400).json({ error: "Cette marchandise n'est pas cotée" });
    }
    if (direction !== "DESSOUS" && direction !== "DESSUS") {
        return res.status(400).json({ error: "Sens d'alerte invalide" });
    }
    if (!Number.isFinite(threshold) || threshold < market_service_1.INDEX_MIN || threshold > market_service_1.INDEX_MAX) {
        return res.status(400).json({ error: "Seuil hors des bornes du cours" });
    }
    const count = await prisma_1.prisma.priceAlert.count({ where: { companyId: company.id } });
    if (count >= MAX_ALERTS) {
        return res.status(409).json({ error: `Vous ne pouvez pas suivre plus de ${MAX_ALERTS} alertes` });
    }
    const alert = await prisma_1.prisma.priceAlert.create({
        data: { companyId: company.id, cargoType, direction, threshold },
    });
    return res.status(201).json(alert);
}
async function deleteAlert(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    await prisma_1.prisma.priceAlert.deleteMany({ where: { id: req.params.id, companyId: company.id } });
    return res.json({ ok: true });
}
/* Marque les alertes déclenchées comme lues. L'interface le fait après avoir
   affiché le message, pour ne pas le répéter à chaque rechargement. */
async function acknowledgeAlerts(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    await prisma_1.prisma.priceAlert.updateMany({
        where: { companyId: company.id, triggeredAt: { not: null }, seen: false },
        data: { seen: true },
    });
    return res.json({ ok: true });
}
async function createStandingOrder(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    if (!company.isPremium) {
        return res.status(403).json({ error: "Les ordres permanents sont réservés aux compagnies Premium" });
    }
    const { cargoType, kind } = req.body;
    const threshold = Number(req.body.threshold);
    const quantity = Number(req.body.quantity);
    if (!market_service_1.TRADED_CARGO.some((c) => c.cargoType === cargoType)) {
        return res.status(400).json({ error: "Cette marchandise n'est pas cotée" });
    }
    if (kind !== "ACHAT" && kind !== "VENTE") {
        return res.status(400).json({ error: "Type d'ordre invalide" });
    }
    if (!Number.isFinite(threshold) || threshold < market_service_1.INDEX_MIN || threshold > market_service_1.INDEX_MAX) {
        return res.status(400).json({ error: "Seuil hors des bornes du cours" });
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        return res.status(400).json({ error: "Quantité invalide" });
    }
    const count = await prisma_1.prisma.standingOrder.count({ where: { companyId: company.id } });
    if (count >= MAX_ORDERS) {
        return res.status(409).json({ error: `Vous ne pouvez pas tenir plus de ${MAX_ORDERS} ordres permanents` });
    }
    const order = await prisma_1.prisma.standingOrder.create({
        data: { companyId: company.id, cargoType, kind, threshold, quantity },
    });
    return res.status(201).json(order);
}
async function deleteStandingOrder(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    await prisma_1.prisma.standingOrder.deleteMany({ where: { id: req.params.id, companyId: company.id } });
    return res.json({ ok: true });
}
/* ============================================================
   Exécution automatique — appelée par le tick de simulation.
   ============================================================ */
/* Alertes : on ne déclenche qu'une fois. Une alerte qui se redéclencherait à
   chaque tick tant que le cours reste sous le seuil noierait le joueur. */
async function checkPriceAlerts() {
    const alerts = await prisma_1.prisma.priceAlert.findMany({ where: { triggeredAt: null } });
    if (alerts.length === 0)
        return;
    const markets = await prisma_1.prisma.cargoMarket.findMany();
    const indexByType = new Map(markets.map((m) => [m.cargoType, m.index]));
    for (const alert of alerts) {
        const index = indexByType.get(alert.cargoType);
        if (index === undefined)
            continue;
        const hit = alert.direction === "DESSOUS" ? index <= alert.threshold : index >= alert.threshold;
        if (!hit)
            continue;
        await prisma_1.prisma.priceAlert.update({
            where: { id: alert.id },
            data: { triggeredAt: new Date(), seen: false },
        });
    }
}
/* Ordres permanents. Un ordre ne s'exécute qu'une fois par franchissement :
   tant que le cours reste du même côté du seuil, il ne repart pas. Le champ
   lastRunAt sert de garde-fou de temps, la désactivation de garde-fou de
   répétition. */
const ORDER_COOLDOWN_MS = 15 * 60000;
async function runStandingOrders() {
    const orders = await prisma_1.prisma.standingOrder.findMany({ where: { active: true } });
    if (orders.length === 0)
        return;
    const markets = await prisma_1.prisma.cargoMarket.findMany();
    const indexByType = new Map(markets.map((m) => [m.cargoType, m.index]));
    for (const order of orders) {
        const index = indexByType.get(order.cargoType);
        if (index === undefined)
            continue;
        if (order.lastRunAt && Date.now() - new Date(order.lastRunAt).getTime() < ORDER_COOLDOWN_MS)
            continue;
        const hit = order.kind === "ACHAT" ? index <= order.threshold : index >= order.threshold;
        if (!hit)
            continue;
        /* On revérifie l'abonnement au moment d'exécuter : un ordre créé pendant
           l'abonnement ne doit pas continuer à tourner après son expiration. */
        const company = await prisma_1.prisma.company.findUnique({
            where: { id: order.companyId },
            select: { isPremium: true },
        });
        if (!company?.isPremium)
            continue;
        const result = order.kind === "ACHAT"
            ? await executeBuy(order.companyId, order.cargoType, order.quantity, true)
            : await executeSell(order.companyId, order.cargoType, order.quantity);
        /* Échec (entrepôt plein, trésorerie insuffisante, stock absent) : l'ordre
           est simplement mis en sommeil jusqu'au prochain créneau, sans message
           d'erreur nulle part — il réessaiera. */
        void result;
        await prisma_1.prisma.standingOrder.update({
            where: { id: order.id },
            data: { lastRunAt: new Date() },
        });
    }
}
