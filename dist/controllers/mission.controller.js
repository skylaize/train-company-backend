"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMyClients = getMyClients;
exports.acceptMission = acceptMission;
exports.declineMission = declineMission;
const prisma_1 = require("../prisma");
const client_service_1 = require("../services/client.service");
const mission_service_1 = require("../services/mission.service");
const leaderboard_service_1 = require("../services/leaderboard.service");
async function companyOf(req) {
    return prisma_1.prisma.company.findUnique({
        where: { ownerId: req.userId },
        select: { id: true, isPremium: true },
    });
}
async function gradeOf(companyId) {
    const rows = await (0, leaderboard_service_1.buildLeaderRows)();
    return rows.find((r) => r.id === companyId)?.gradeId ?? 0;
}
async function getMyClients(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    const gradeId = await gradeOf(company.id);
    await (0, mission_service_1.refreshMissionsFor)(company.id, gradeId, company.isPremium);
    const [relations, missions] = await Promise.all([
        prisma_1.prisma.clientRelation.findMany({ where: { companyId: company.id } }),
        prisma_1.prisma.mission.findMany({
            where: { companyId: company.id, status: { in: ["PROPOSEE", "ACCEPTEE", "ECHOUEE"] } },
            orderBy: { createdAt: "desc" },
        }),
    ]);
    const repByClient = new Map(relations.map((r) => [r.clientId, r.reputation]));
    const list = missions;
    const payload = client_service_1.CLIENTS.map((client) => {
        const locked = client.minGradeId > gradeId;
        const reputation = repByClient.get(client.id) ?? 0;
        const lvl = (0, client_service_1.levelFromReputation)(reputation);
        const next = (0, client_service_1.nextLevel)(reputation);
        /* Tous les ordres ouverts du chargeur — un abonné en a deux. Si aucun
           n'est ouvert, on montre le dernier échec : le joueur doit comprendre
           pourquoi sa réputation a bougé plutôt que de le découvrir sans
           explication. */
        const open = list.filter((m) => m.clientId === client.id && m.status !== "ECHOUEE");
        const current = open.length > 0 ? open : list.filter((m) => m.clientId === client.id).slice(0, 1);
        return {
            id: client.id,
            name: client.name,
            sector: client.sector,
            city: client.city,
            cargoTypes: client.cargoTypes,
            color: client.color,
            colorPaper: client.colorPaper,
            locked,
            lockReason: locked
                ? `Ce chargeur ne traite qu'avec les compagnies ayant atteint un grade supérieur.`
                : null,
            reputation,
            reputationMax: client_service_1.REPUTATION_MAX,
            levelName: lvl.name,
            bonus: Math.round(lvl.bonus * 100),
            nextLevelAt: next ? next.from : null,
            nextLevelName: next ? next.name : null,
            missions: locked
                ? []
                : current.map((m) => ({
                    id: m.id,
                    cargoType: m.cargoType,
                    target: m.target,
                    progress: m.progress,
                    reward: m.reward,
                    repReward: m.repReward,
                    status: m.status,
                    offerUntil: m.offerUntil,
                    dueAt: m.dueAt,
                    // référence lisible, dans le vocabulaire du bordereau
                    ref: `${client.id.slice(0, 2)}-${m.id.slice(0, 4).toUpperCase()}`,
                })),
        };
    });
    return res.json({ clients: payload, failurePenalty: client_service_1.FAILURE_PENALTY });
}
async function acceptMission(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    const mission = await prisma_1.prisma.mission.findFirst({
        where: { id: req.params.id, companyId: company.id, status: "PROPOSEE" },
    });
    if (!mission)
        return res.status(404).json({ error: "Cet ordre n'est plus disponible" });
    if (new Date(mission.offerUntil).getTime() < Date.now()) {
        return res.status(400).json({ error: "Le délai pour accepter cet ordre est dépassé" });
    }
    const updated = await prisma_1.prisma.mission.update({
        where: { id: mission.id },
        data: {
            status: "ACCEPTEE",
            // l'échéance ne court qu'à partir de l'acceptation
            dueAt: new Date(Date.now() + (0, mission_service_1.deadlineHoursFor)(mission.target) * 3600000),
        },
    });
    return res.json({ id: updated.id, status: updated.status, dueAt: updated.dueAt });
}
async function declineMission(req, res) {
    const company = await companyOf(req);
    if (!company)
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    const mission = await prisma_1.prisma.mission.findFirst({
        where: { id: req.params.id, companyId: company.id, status: "PROPOSEE" },
    });
    if (!mission)
        return res.status(404).json({ error: "Cet ordre n'est plus disponible" });
    // refuser ne coûte pas de réputation : seul un engagement non tenu en coûte
    await prisma_1.prisma.mission.update({ where: { id: mission.id }, data: { status: "ECHOUEE" } });
    return res.json({ ok: true });
}
