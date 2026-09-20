"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOARDS = exports.PUNCTUALITY_MIN_SAMPLE = void 0;
exports.buildLeaderRows = buildLeaderRows;
exports.rankRows = rankRows;
const prisma_1 = require("../prisma");
const career_service_1 = require("./career.service");
/* Prix d'achat des rames : sert à valoriser le parc, pas seulement les liquidités.
   Doit rester aligné sur TRAIN_MODELS dans train.controller.ts. */
const TRAIN_VALUE = {
    STANDARD: 200,
    EXPRESS: 450,
    FRET_LOURD: 450,
};
/* Une rame usée à 100 % ne vaut plus que la moitié de son prix. */
function trainWorth(model, wear) {
    const base = TRAIN_VALUE[model] ?? TRAIN_VALUE.STANDARD;
    return Math.round(base * (1 - Math.min(100, Math.max(0, wear)) / 200));
}
/* Somme réellement dépensée pour agrandir le dépôt : chaque place coûte
   maxTrains × 200, en partant de 2 places offertes à la fondation. */
function depotInvestment(maxTrains) {
    if (maxTrains <= 2)
        return 0;
    return 200 * (((maxTrains - 1) * maxTrains) / 2 - 1);
}
/* Nombre minimum de trajets avant d'apparaître au classement de ponctualité :
   sans ce seuil, une compagnie neuve avec un seul trajet trônerait à 100 %. */
exports.PUNCTUALITY_MIN_SAMPLE = 10;
/* Additionne des couples (compagnie, valeur) en ignorant les lignes sans compagnie. */
function sumByCompany(pairs) {
    const map = new Map();
    for (const [key, value] of pairs) {
        if (!key)
            continue;
        map.set(key, (map.get(key) ?? 0) + value);
    }
    return map;
}
/* Huit requêtes d'agrégation par appel, et chaque tableau de bord connecté
   redemande le classement toutes les dix secondes. Quinze secondes de cache :
   assez court pour que le classement reste vivant, assez long pour que la base
   ne refasse pas le même calcul pour chaque joueur. */
const ROWS_TTL_MS = 15000;
let rowsCache = null;
async function buildLeaderRows() {
    if (rowsCache && Date.now() - rowsCache.at < ROWS_TTL_MS)
        return rowsCache.rows;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [companies, trains, revenue, delivered, freightWeek, goodTrips, incidents, referrals] = await Promise.all([
        prisma_1.prisma.company.findMany({
            select: {
                id: true,
                name: true,
                liveryColor: true,
                balance: true,
                maxTrains: true,
                title: true,
                _count: { select: { trains: true, lines: true, staff: true } },
            },
        }),
        prisma_1.prisma.train.findMany({ select: { companyId: true, model: true, wear: true } }),
        prisma_1.prisma.transaction.groupBy({
            by: ["companyId"],
            where: { amount: { gt: 0 }, type: { not: "FONDATION" } },
            _sum: { amount: true },
        }),
        prisma_1.prisma.contract.groupBy({
            by: ["companyId"],
            where: { status: "LIVREE" },
            _count: { _all: true },
        }),
        prisma_1.prisma.transaction.groupBy({
            by: ["companyId"],
            where: { type: "FRET", amount: { gt: 0 }, createdAt: { gte: weekAgo } },
            _count: { _all: true },
        }),
        prisma_1.prisma.transaction.groupBy({
            by: ["companyId"],
            where: { type: "REVENU_LIGNE" },
            _count: { _all: true },
        }),
        // les incidents pointent sur un train : on remonte à la compagnie côté serveur
        prisma_1.prisma.incident.findMany({ select: { train: { select: { companyId: true } } } }),
        // un filleul ne compte que s'il a vraiment démarré (récompense déjà versée)
        prisma_1.prisma.company.groupBy({
            by: ["referredById"],
            where: { referredById: { not: null }, referralRewardGranted: true },
            _count: { _all: true },
        }),
    ]);
    const trainWorthByCompany = sumByCompany(trains.map((t) => [
        t.companyId,
        trainWorth(t.model, t.wear),
    ]));
    const revenueBy = sumByCompany(revenue.map((r) => [
        r.companyId,
        r._sum.amount ?? 0,
    ]));
    const deliveredBy = sumByCompany(delivered.map((d) => [
        d.companyId,
        d._count._all,
    ]));
    const freightWeekBy = sumByCompany(freightWeek.map((f) => [
        f.companyId,
        f._count._all,
    ]));
    const goodTripsBy = sumByCompany(goodTrips.map((g) => [
        g.companyId,
        g._count._all,
    ]));
    const incidentsBy = sumByCompany(incidents.map((i) => [
        i.train?.companyId ?? null,
        1,
    ]));
    const referralsBy = sumByCompany(referrals.map((r) => [
        r.referredById,
        r._count._all,
    ]));
    const rows = companies.map((c) => {
        const good = goodTripsBy.get(c.id) ?? 0;
        const bad = incidentsBy.get(c.id) ?? 0;
        const sample = good + bad;
        const ponctualite = sample === 0 ? 100 : Math.round((good / sample) * 100);
        const ctx = {
            trainCount: c._count.trains,
            lineCount: c._count.lines,
            staffCount: c._count.staff,
            freightDelivered: deliveredBy.get(c.id) ?? 0,
            totalRevenue: revenueBy.get(c.id) ?? 0,
            reputation: ponctualite,
            maxTrains: c.maxTrains,
        };
        return {
            id: c.id,
            name: c.name,
            liveryColor: c.liveryColor,
            grade: (0, career_service_1.rankFromContext)(ctx).name,
            gradeId: (0, career_service_1.rankFromContext)(ctx).id,
            title: c.title,
            trains: c._count.trains,
            lines: c._count.lines,
            // la valeur remplace la trésorerie brute : acheter une rame ne fait plus reculer
            valeur: c.balance + (trainWorthByCompany.get(c.id) ?? 0) + depotInvestment(c.maxTrains),
            livraisons: freightWeekBy.get(c.id) ?? 0,
            ponctualite,
            ponctualiteSample: sample,
            parrains: referralsBy.get(c.id) ?? 0,
        };
    });
    rowsCache = { at: Date.now(), rows };
    return rows;
}
exports.BOARDS = [
    {
        id: "valeur",
        label: "Valeur",
        note: "Trésorerie, matériel et dépôt réunis",
        unit: "pi.",
        missing: "Fondez votre compagnie pour entrer au classement.",
    },
    {
        id: "livraisons",
        label: "Fret de la semaine",
        note: "Contrats livrés ces sept derniers jours",
        unit: "",
        missing: "Livrez un contrat de fret cette semaine pour y figurer.",
    },
    {
        id: "ponctualite",
        label: "Ponctualité",
        note: `À partir de ${exports.PUNCTUALITY_MIN_SAMPLE} trajets effectués`,
        unit: "%",
        missing: `Effectuez ${exports.PUNCTUALITY_MIN_SAMPLE} trajets pour y figurer — en dessous, le pourcentage ne veut rien dire.`,
    },
    {
        id: "parrains",
        label: "Parrains",
        note: "Filleuls ayant réellement pris le départ",
        unit: "",
        missing: "Invitez un ami : il apparaît ici dès qu'il a lancé sa première ligne.",
    },
];
function rankRows(rows, board) {
    const eligible = board === "ponctualite"
        ? rows.filter((r) => r.ponctualiteSample >= exports.PUNCTUALITY_MIN_SAMPLE)
        : board === "parrains"
            ? rows.filter((r) => r.parrains > 0)
            : board === "livraisons"
                ? rows.filter((r) => r.livraisons > 0)
                : rows;
    return [...eligible]
        .sort((a, b) => {
        const diff = b[board] - a[board];
        // à égalité, la compagnie la plus solide passe devant
        return diff !== 0 ? diff : b.valeur - a.valeur;
    })
        .map((r, i) => ({ ...r, rank: i + 1 }));
}
