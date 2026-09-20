"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRAIN_MODELS = void 0;
exports.buyTrain = buyTrain;
exports.assignTrainToLine = assignTrainToLine;
exports.repairTrain = repairTrain;
exports.renameTrain = renameTrain;
exports.releaseTrain = releaseTrain;
exports.listMyTrains = listMyTrains;
const prisma_1 = require("../prisma");
const leaderboard_service_1 = require("../services/leaderboard.service");
async function getOwnedCompanyOrFail(userId) {
    return prisma_1.prisma.company.findUnique({ where: { ownerId: userId } });
}
/* Le matériel se débloque au grade de carrière, plus à l'abonnement.
   Deux modèles sur trois étaient marqués Premium alors qu'aucune route ne rend
   une compagnie Premium : personne ne pouvait les acheter, et tout le monde
   roulait en Standard. Le choix de matériel n'existait tout simplement pas. */
exports.TRAIN_MODELS = {
    STANDARD: { cost: 200, minGradeId: 0 },
    EXPRESS: { cost: 450, minGradeId: 1 }, // Gestionnaire confirmé
    FRET_LOURD: { cost: 450, minGradeId: 2 }, // Chef de réseau
};
async function buyTrain(req, res) {
    const { name, model } = req.body;
    const chosenModel = model && exports.TRAIN_MODELS[model] ? model : "STANDARD";
    const { cost: TRAIN_COST, minGradeId } = exports.TRAIN_MODELS[chosenModel];
    if (!name) {
        return res.status(400).json({ error: "Le nom du train est requis" });
    }
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    if (minGradeId > 0) {
        const rows = await (0, leaderboard_service_1.buildLeaderRows)();
        const gradeId = rows.find((r) => r.id === company.id)?.gradeId ?? 0;
        if (gradeId < minGradeId) {
            const needed = minGradeId === 1 ? "Gestionnaire confirmé" : "Chef de réseau";
            return res.status(403).json({ error: `Ce modèle demande le grade « ${needed} »` });
        }
    }
    const trainCount = await prisma_1.prisma.train.count({ where: { companyId: company.id } });
    if (trainCount >= company.maxTrains) {
        return res.status(403).json({ error: `Capacité du dépôt atteinte (${company.maxTrains} rames). Agrandissez-le pour continuer.` });
    }
    if (company.balance < TRAIN_COST) {
        return res.status(409).json({ error: `Trésorerie insuffisante (achat : ${TRAIN_COST} pièces)` });
    }
    const [train] = await prisma_1.prisma.$transaction([
        prisma_1.prisma.train.create({ data: { name, model: chosenModel, companyId: company.id } }),
        prisma_1.prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: TRAIN_COST } } }),
        prisma_1.prisma.transaction.create({
            data: {
                companyId: company.id,
                type: "ACHAT_TRAIN",
                amount: -TRAIN_COST,
                description: `Achat de ${name}`,
            },
        }),
    ]);
    return res.status(201).json(train);
}
async function assignTrainToLine(req, res) {
    const { trainId, lineId } = req.body;
    if (!trainId || !lineId) {
        return res.status(400).json({ error: "trainId et lineId sont requis" });
    }
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const train = await prisma_1.prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
    if (!train) {
        return res.status(404).json({ error: "Train introuvable" });
    }
    if (train.status !== "IDLE") {
        return res.status(409).json({ error: "Ce train est déjà en service (ligne ou fret en cours)" });
    }
    if (train.wear >= 100) {
        return res.status(409).json({ error: "Ce train doit être réparé avant de pouvoir circuler" });
    }
    const line = await prisma_1.prisma.line.findFirst({ where: { id: lineId, companyId: company.id } });
    if (!line) {
        return res.status(404).json({ error: "Ligne introuvable" });
    }
    const updated = await prisma_1.prisma.train.update({
        where: { id: trainId },
        data: {
            lineId,
            status: "EN_ROUTE",
            progress: 0,
            departedAt: new Date(),
        },
    });
    return res.json(updated);
}
const REPAIR_COST_PER_POINT = 2; // pièces par point d'usure à réparer (réduit pour éviter qu'une double panne ne bloque un nouveau joueur)
async function repairTrain(req, res) {
    const { trainId } = req.body;
    if (!trainId) {
        return res.status(400).json({ error: "trainId est requis" });
    }
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const train = await prisma_1.prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
    if (!train) {
        return res.status(404).json({ error: "Train introuvable" });
    }
    if (train.wear === 0) {
        return res.status(409).json({ error: "Ce train n'a pas besoin de réparation" });
    }
    const hasChefDepot = await prisma_1.prisma.staff.count({ where: { companyId: company.id, role: "CHEF_DEPOT" } }) > 0;
    /* La remise Premium sur les réparations a été retirée : elle abaissait les
       charges, donc elle déplaçait la taille optimale d'une compagnie. Premium
       ne doit pas faire aller plus HAUT, seulement plus vite ou plus confortablement. */
    const costPerPoint = hasChefDepot ? 1 : REPAIR_COST_PER_POINT;
    const cost = Math.ceil(train.wear * costPerPoint);
    if (company.balance < cost) {
        return res.status(409).json({ error: `Trésorerie insuffisante (réparation : ${cost} pièces)` });
    }
    const resumesLine = train.status === "MAINTENANCE" && train.lineId;
    const [updatedTrain] = await prisma_1.prisma.$transaction([
        prisma_1.prisma.train.update({
            where: { id: trainId },
            data: resumesLine
                ? { wear: 0, status: "EN_ROUTE", progress: 0, departedAt: new Date() }
                : { wear: 0 },
        }),
        prisma_1.prisma.company.update({
            where: { id: company.id },
            data: { balance: { decrement: cost } },
        }),
        prisma_1.prisma.transaction.create({
            data: {
                companyId: company.id,
                type: "REPARATION",
                amount: -cost,
                description: `Réparation de ${train.name}`,
            },
        }),
    ]);
    return res.json(updatedTrain);
}
async function renameTrain(req, res) {
    const { trainId, name } = req.body;
    if (!trainId || !name) {
        return res.status(400).json({ error: "trainId et name sont requis" });
    }
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const train = await prisma_1.prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
    if (!train) {
        return res.status(404).json({ error: "Train introuvable" });
    }
    const updated = await prisma_1.prisma.train.update({ where: { id: trainId }, data: { name } });
    return res.json(updated);
}
async function releaseTrain(req, res) {
    const { trainId } = req.body;
    if (!trainId) {
        return res.status(400).json({ error: "trainId est requis" });
    }
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const train = await prisma_1.prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
    if (!train) {
        return res.status(404).json({ error: "Train introuvable" });
    }
    if (!train.lineId) {
        return res.status(409).json({ error: "Ce train n'est affecté à aucune ligne" });
    }
    if (train.status === "MAINTENANCE") {
        return res.status(409).json({ error: "Ce train est en panne, réparez-le d'abord" });
    }
    const updated = await prisma_1.prisma.train.update({
        where: { id: trainId },
        data: { lineId: null, status: "IDLE", progress: 0, departedAt: null },
    });
    return res.json(updated);
}
async function listMyTrains(req, res) {
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const trains = await prisma_1.prisma.train.findMany({
        where: { companyId: company.id },
        include: { line: true },
    });
    return res.json(trains);
}
