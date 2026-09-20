"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConstructions = getConstructions;
exports.startConstruction = startConstruction;
const prisma_1 = require("../prisma");
const construction_service_1 = require("../services/construction.service");
const KINDS = ["DEPOT", "ENTREPOT", "ENTREPOT_AGRANDISSEMENT"];
async function companyOf(req) {
    return prisma_1.prisma.company.findUnique({
        where: { ownerId: req.userId },
        select: { id: true, balance: true, maxTrains: true, isPremium: true },
    });
}
async function getConstructions(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    const [current, quotes, warehouse, recent] = await Promise.all([
        (0, construction_service_1.activeConstruction)(company.id),
        Promise.all(KINDS.map((k) => (0, construction_service_1.quoteFor)(company.id, k))),
        prisma_1.prisma.warehouse.findUnique({ where: { companyId: company.id } }),
        prisma_1.prisma.construction.findMany({
            where: { companyId: company.id, done: true },
            orderBy: { endsAt: "desc" },
            take: 5,
        }),
    ]);
    return res.json({
        current,
        quotes: quotes.filter(Boolean),
        warehouse,
        capacityStep: construction_service_1.WAREHOUSE_CAPACITY_STEP,
        balance: company.balance,
        recent,
    });
}
async function startConstruction(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    const kind = req.body.kind;
    if (!KINDS.includes(kind)) {
        return res.status(400).json({ error: "Type de chantier inconnu" });
    }
    /* Un seul chantier à la fois : c'est toute la règle. Sans elle, une grosse
       trésorerie lancerait dix chantiers en parallèle et le temps cesserait
       d'être une contrainte. */
    const running = await (0, construction_service_1.activeConstruction)(company.id);
    if (running) {
        return res.status(409).json({ error: "Un chantier est déjà en cours" });
    }
    const quote = await (0, construction_service_1.quoteFor)(company.id, kind);
    if (!quote)
        return res.status(404).json({ error: "Devis indisponible" });
    if (!quote.available) {
        return res.status(409).json({ error: quote.reason ?? "Ce chantier n'est pas disponible" });
    }
    if (company.balance < quote.cost) {
        return res.status(409).json({ error: `Trésorerie insuffisante (${quote.cost} pièces)` });
    }
    const endsAt = new Date(Date.now() + quote.hours * 3600000);
    const [construction] = await prisma_1.prisma.$transaction([
        prisma_1.prisma.construction.create({
            data: {
                companyId: company.id,
                kind,
                label: quote.label,
                cost: quote.cost,
                endsAt,
            },
        }),
        prisma_1.prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: quote.cost } } }),
        prisma_1.prisma.transaction.create({
            data: {
                companyId: company.id,
                type: "CHANTIER",
                amount: -quote.cost,
                description: `${quote.label} — chantier lancé`,
            },
        }),
    ]);
    return res.status(201).json(construction);
}
