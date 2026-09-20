"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.targetFor = targetFor;
exports.deadlineHoursFor = deadlineHoursFor;
exports.rewardFor = rewardFor;
exports.repRewardFor = repRewardFor;
exports.refreshMissionsFor = refreshMissionsFor;
exports.creditDelivery = creditDelivery;
exports.expireMissions = expireMissions;
exports.requiredCargoTypes = requiredCargoTypes;
const prisma_1 = require("../prisma");
const client_service_1 = require("./client.service");
/* ============================================================
   Génération et cycle de vie des ordres de mission.

   Les missions sont tirées au sort, mais dans des bornes : la quantité
   dépend du grade du joueur et de sa relation avec le client. Un tirage
   libre donnerait des ordres infaisables à un débutant et dérisoires à
   un vétéran — dans les deux cas le système perd tout intérêt.
   ============================================================ */
/* Valeur de référence d'une cargaison, alignée sur CARGO_TEMPLATES.
   Sert uniquement à calculer une prime de mission cohérente avec ce que
   les mêmes livraisons rapporteraient au marché. */
const CARGO_BASE = {
    "Céréales": 120,
    "Acier": 180,
    "Conteneurs": 90,
    "Bois": 100,
    "Automobiles": 150,
    "Produits chimiques": 140,
    "Verre soufflé": 230,
    "Œuvres d'art": 340,
    "Produits pharmaceutiques réfrigérés": 190,
};
const OFFER_WINDOW_H = 6; // délai pour accepter ou refuser
const COOLDOWN_H = 2; // repos du client après un refus ou un échec
function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}
/* Quantité demandée : 2 au départ, jusqu'à 8 pour un Baron du rail
   déjà bien installé chez le client. Le +/- 1 aléatoire évite que deux
   missions successives soient identiques. */
function targetFor(gradeId, clientLevel) {
    const base = 2 + Math.floor(gradeId / 2) + clientLevel;
    const jitter = Math.random() < 0.5 ? 0 : 1;
    return Math.max(2, Math.min(8, base + jitter));
}
/* Délai de livraison : plus la commande est grosse, plus on laisse de temps.
   24 h pour deux cargaisons, jusqu'à 72 h pour huit. */
function deadlineHoursFor(target) {
    return Math.min(72, 24 + (target - 2) * 8);
}
/* Prime : ce que les mêmes livraisons rapporteraient au marché, majoré de
   35 %. En dessous, accepter une contrainte de délai n'aurait aucun intérêt. */
function rewardFor(cargoType, target) {
    const base = CARGO_BASE[cargoType] ?? 120;
    return Math.round(base * target * 0.35);
}
function repRewardFor(target) {
    return 8 + target;
}
/* Propose un ordre pour chaque client accessible et sans ordre en cours. */
/* Un abonné reçoit deux ordres par chargeur au lieu d'un. C'est du choix, pas
   du rendement : la prime et la réputation d'un ordre sont identiques pour
   tout le monde, l'abonné a seulement plus d'options sur la table. */
async function refreshMissionsFor(companyId, gradeId, isPremium = false) {
    const ordersPerClient = isPremium ? 2 : 1;
    const [relations, missions] = await Promise.all([
        prisma_1.prisma.clientRelation.findMany({ where: { companyId } }),
        prisma_1.prisma.mission.findMany({
            where: { companyId, status: { in: ["PROPOSEE", "ACCEPTEE"] } },
        }),
    ]);
    const repByClient = new Map(relations.map((r) => [r.clientId, r.reputation]));
    const openByClient = new Map();
    missions.forEach((m) => {
        openByClient.set(m.clientId, (openByClient.get(m.clientId) ?? 0) + 1);
    });
    const now = Date.now();
    for (const client of client_service_1.CLIENTS) {
        if (client.minGradeId > gradeId)
            continue;
        if ((openByClient.get(client.id) ?? 0) >= ordersPerClient)
            continue;
        /* Repos du client après un refus ou un échec : sans ça, refuser ne
           coûterait rien puisqu'un nouvel ordre arriverait dans la seconde.
           On ne l'applique que si le chargeur n'a aucun ordre ouvert — sinon
           le deuxième ordre d'un abonné ne serait jamais créé, l'offre en cours
           repoussant elle-même l'échéance. */
        const hasOpen = (openByClient.get(client.id) ?? 0) > 0;
        const last = hasOpen ? null : await prisma_1.prisma.mission.findFirst({
            where: { companyId, clientId: client.id },
            orderBy: { createdAt: "desc" },
            select: { status: true, createdAt: true, offerUntil: true },
        });
        if (last) {
            const ref = last.status === "PROPOSEE" ? last.offerUntil : last.createdAt;
            if (now - new Date(ref).getTime() < COOLDOWN_H * 3600000)
                continue;
        }
        const rep = repByClient.get(client.id) ?? 0;
        const level = (0, client_service_1.levelFromReputation)(rep).level;
        const cargoType = pick(client.cargoTypes);
        const target = targetFor(gradeId, level);
        await prisma_1.prisma.mission.create({
            data: {
                companyId,
                clientId: client.id,
                cargoType,
                target,
                reward: rewardFor(cargoType, target),
                repReward: repRewardFor(target),
                status: "PROPOSEE",
                offerUntil: new Date(now + OFFER_WINDOW_H * 3600000),
            },
        });
        openByClient.set(client.id, (openByClient.get(client.id) ?? 0) + 1);
    }
}
/* Appelé à chaque livraison de fret : fait avancer l'ordre correspondant. */
async function creditDelivery(companyId, cargoType) {
    const mission = await prisma_1.prisma.mission.findFirst({
        where: { companyId, cargoType, status: "ACCEPTEE" },
        orderBy: { createdAt: "asc" },
    });
    if (!mission)
        return null;
    const progress = mission.progress + 1;
    if (progress < mission.target) {
        await prisma_1.prisma.mission.update({ where: { id: mission.id }, data: { progress } });
        return null;
    }
    // ordre honoré : prime, réputation, trace au grand livre
    const client = (0, client_service_1.clientById)(mission.clientId);
    await prisma_1.prisma.$transaction([
        prisma_1.prisma.mission.update({
            where: { id: mission.id },
            data: { progress, status: "REUSSIE" },
        }),
        prisma_1.prisma.company.update({
            where: { id: companyId },
            data: { balance: { increment: mission.reward } },
        }),
        prisma_1.prisma.transaction.create({
            data: {
                companyId,
                type: "MISSION",
                amount: mission.reward,
                description: `Ordre honoré pour ${client?.name ?? mission.clientId} — ${mission.target} × ${mission.cargoType}`,
            },
        }),
    ]);
    await bumpReputation(companyId, mission.clientId, mission.repReward);
    return { clientName: client?.name ?? mission.clientId, reward: mission.reward };
}
async function bumpReputation(companyId, clientId, delta) {
    const existing = await prisma_1.prisma.clientRelation.findUnique({
        where: { companyId_clientId: { companyId, clientId } },
    });
    const current = existing?.reputation ?? 0;
    const next = Math.max(0, Math.min(client_service_1.REPUTATION_MAX, current + delta));
    const level = (0, client_service_1.levelFromReputation)(next).level;
    if (existing) {
        await prisma_1.prisma.clientRelation.update({
            where: { id: existing.id },
            data: { reputation: next, level },
        });
    }
    else {
        await prisma_1.prisma.clientRelation.create({
            data: { companyId, clientId, reputation: next, level },
        });
    }
}
/* Passe les offres non répondues et les ordres en retard à l'échec.
   Tourne dans la boucle de simulation. */
async function expireMissions() {
    const now = new Date();
    const stale = await prisma_1.prisma.mission.findMany({
        where: {
            OR: [
                { status: "PROPOSEE", offerUntil: { lt: now } },
                { status: "ACCEPTEE", dueAt: { lt: now } },
            ],
        },
        select: { id: true, status: true, companyId: true, clientId: true },
    });
    if (stale.length === 0)
        return;
    for (const m of stale) {
        await prisma_1.prisma.mission.update({ where: { id: m.id }, data: { status: "ECHOUEE" } });
        /* Une offre ignorée ne coûte rien : le joueur n'a rien promis.
           Un ordre accepté puis non tenu, si. C'est ce qui donne du poids à
           l'acceptation — sans cela, accepter serait toujours gratuit. */
        if (m.status === "ACCEPTEE") {
            await bumpReputation(m.companyId, m.clientId, -client_service_1.FAILURE_PENALTY);
            const client = (0, client_service_1.clientById)(m.clientId);
            await prisma_1.prisma.transaction.create({
                data: {
                    companyId: m.companyId,
                    type: "MISSION",
                    amount: 0,
                    description: `Ordre non honoré — ${client?.name ?? m.clientId} retire sa confiance`,
                },
            });
        }
    }
}
/* Marchandises à garantir sur le marché : sans ça, un ordre portant sur une
   cargaison qui n'apparaît jamais serait impossible à tenir, et le joueur
   perdrait de la réputation sans avoir rien fait de mal. */
async function requiredCargoTypes() {
    const active = await prisma_1.prisma.mission.findMany({
        where: { status: "ACCEPTEE" },
        select: { cargoType: true },
    });
    return new Set(active.map((m) => m.cargoType));
}
