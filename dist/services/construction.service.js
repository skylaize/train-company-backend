"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STOCK_TYPES_PREMIUM = exports.STOCK_TYPES_FREE = exports.WAREHOUSE_EXPANSION_GROWTH = exports.WAREHOUSE_EXPANSION_BASE = exports.WAREHOUSE_CAPACITY_STEP = exports.WAREHOUSE_BASE_CAPACITY = exports.WAREHOUSE_BUILD_COST = void 0;
exports.warehouseExpansionCost = warehouseExpansionCost;
exports.depotBuildHours = depotBuildHours;
exports.warehouseBuildHours = warehouseBuildHours;
exports.warehouseExpansionHours = warehouseExpansionHours;
exports.quoteFor = quoteFor;
exports.activeConstruction = activeConstruction;
exports.completeConstructions = completeConstructions;
const prisma_1 = require("../prisma");
const upkeep_service_1 = require("./upkeep.service");
/* ============================================================
   Chantiers.

   Le problème que ça corrige : l'argent se convertissait instantanément en
   progression. Une compagnie qui avait accumulé 30 000 pièces achetait dix
   places de dépôt en dix clics et se retrouvait devant exactement le même jeu,
   en plus grand, sans avoir rien décidé.

   Un chantier prend du temps réel et il n'y en a qu'un à la fois. La
   trésorerie ne suffit donc plus : il faut aussi choisir l'ORDRE dans lequel
   on construit, et vivre avec ce choix pendant quelques heures.

   Règle importante : les abonnés ne construisent pas plus vite. Accélérer les
   chantiers serait vendre du rendement ; on s'y est refusé partout ailleurs,
   il n'y a pas de raison de céder ici.
   ============================================================ */
exports.WAREHOUSE_BUILD_COST = 1200;
exports.WAREHOUSE_BASE_CAPACITY = 20;
exports.WAREHOUSE_CAPACITY_STEP = 15;
exports.WAREHOUSE_EXPANSION_BASE = 900;
exports.WAREHOUSE_EXPANSION_GROWTH = 1.65;
/* Nombre de marchandises différentes stockables en même temps. C'est là que se
   place l'avantage des abonnés : de la VARIÉTÉ, pas du volume. Un abonné peut
   suivre cinq cours à la fois, il ne peut pas stocker une unité de plus. */
exports.STOCK_TYPES_FREE = 2;
exports.STOCK_TYPES_PREMIUM = 5;
function warehouseExpansionCost(level) {
    return Math.round(exports.WAREHOUSE_EXPANSION_BASE * Math.pow(exports.WAREHOUSE_EXPANSION_GROWTH, Math.max(0, level - 1)));
}
/* Durées, en heures. Volontairement courtes au début — un nouveau joueur ne
   doit pas attendre sa première place de dépôt une demi-journée — et longues
   ensuite, là où le jeu manquait de frein. */
function depotBuildHours(currentSlots) {
    return Math.min(6, 0.5 * Math.pow(1.35, Math.max(0, currentSlots - 2)));
}
function warehouseBuildHours() {
    return 2;
}
function warehouseExpansionHours(level) {
    return Math.min(8, 2 + 0.75 * Math.max(0, level - 1));
}
/* Ce qu'un chantier donné coûterait et durerait, pour l'afficher avant la
   commande. Le joueur doit voir le temps AVANT de payer, sinon le chantier est
   une mauvaise surprise et non une décision. */
async function quoteFor(companyId, kind) {
    const company = await prisma_1.prisma.company.findUnique({
        where: { id: companyId },
        select: { maxTrains: true, isPremium: true },
    });
    if (!company)
        return null;
    const warehouse = await prisma_1.prisma.warehouse.findUnique({ where: { companyId } });
    if (kind === "DEPOT") {
        return {
            kind,
            label: `Agrandissement du dépôt (${company.maxTrains + 1} places)`,
            cost: (0, upkeep_service_1.depotExpansionCost)(company.maxTrains, company.isPremium),
            hours: depotBuildHours(company.maxTrains),
            available: true,
            reason: null,
        };
    }
    if (kind === "ENTREPOT") {
        return {
            kind,
            label: "Construction de l'entrepôt",
            cost: exports.WAREHOUSE_BUILD_COST,
            hours: warehouseBuildHours(),
            available: !warehouse,
            reason: warehouse ? "Votre compagnie possède déjà un entrepôt" : null,
        };
    }
    return {
        kind,
        label: warehouse
            ? `Agrandissement de l'entrepôt (${warehouse.capacity + exports.WAREHOUSE_CAPACITY_STEP} unités)`
            : "Agrandissement de l'entrepôt",
        cost: warehouse ? warehouseExpansionCost(warehouse.level) : exports.WAREHOUSE_EXPANSION_BASE,
        hours: warehouse ? warehouseExpansionHours(warehouse.level) : warehouseExpansionHours(1),
        available: Boolean(warehouse),
        reason: warehouse ? null : "Construisez d'abord un entrepôt",
    };
}
async function activeConstruction(companyId) {
    return prisma_1.prisma.construction.findFirst({
        where: { companyId, done: false },
        orderBy: { startedAt: "desc" },
    });
}
/* Livraison des chantiers arrivés à terme. Appelée par le tick de simulation :
   le chantier se termine que le joueur soit connecté ou non, sinon fermer
   l'onglet reviendrait à mettre le temps en pause. */
async function completeConstructions() {
    const due = await prisma_1.prisma.construction.findMany({
        where: { done: false, endsAt: { lte: new Date() } },
    });
    for (const c of due) {
        if (c.kind === "DEPOT") {
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.company.update({ where: { id: c.companyId }, data: { maxTrains: { increment: 1 } } }),
                prisma_1.prisma.construction.update({ where: { id: c.id }, data: { done: true } }),
            ]);
        }
        else if (c.kind === "ENTREPOT") {
            const existing = await prisma_1.prisma.warehouse.findUnique({ where: { companyId: c.companyId } });
            await prisma_1.prisma.$transaction([
                ...(existing
                    ? []
                    : [
                        prisma_1.prisma.warehouse.create({
                            data: { companyId: c.companyId, capacity: exports.WAREHOUSE_BASE_CAPACITY, level: 1 },
                        }),
                    ]),
                prisma_1.prisma.construction.update({ where: { id: c.id }, data: { done: true } }),
            ]);
        }
        else {
            const existing = await prisma_1.prisma.warehouse.findUnique({ where: { companyId: c.companyId } });
            await prisma_1.prisma.$transaction([
                ...(existing
                    ? [
                        prisma_1.prisma.warehouse.update({
                            where: { companyId: c.companyId },
                            data: {
                                capacity: { increment: exports.WAREHOUSE_CAPACITY_STEP },
                                level: { increment: 1 },
                            },
                        }),
                    ]
                    : []),
                prisma_1.prisma.construction.update({ where: { id: c.id }, data: { done: true } }),
            ]);
        }
    }
}
