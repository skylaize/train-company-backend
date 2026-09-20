"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLine = createLine;
exports.updateLine = updateLine;
exports.deleteLine = deleteLine;
exports.listMyLines = listMyLines;
const prisma_1 = require("../prisma");
const geography_service_1 = require("../services/geography.service");
async function getOwnedCompanyOrFail(userId) {
    return prisma_1.prisma.company.findUnique({ where: { ownerId: userId } });
}
async function createLine(req, res) {
    const { name, departureStation, arrivalStation } = req.body;
    if (!name || !departureStation || !arrivalStation) {
        return res.status(400).json({
            error: "name, departureStation et arrivalStation sont requis",
        });
    }
    if (departureStation === arrivalStation) {
        return res.status(400).json({ error: "Les deux gares doivent être différentes" });
    }
    if (!(0, geography_service_1.isKnownStation)(departureStation) || !(0, geography_service_1.isKnownStation)(arrivalStation)) {
        return res.status(400).json({ error: "Gare inconnue du réseau" });
    }
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    /* La durée vient de la distance, jamais du client : le rendement croît avec
       la longueur, donc une durée déclarée serait une prime gratuite. */
    const durationMinutes = (0, geography_service_1.durationBetween)(departureStation, arrivalStation);
    const line = await prisma_1.prisma.line.create({
        data: {
            name,
            departureStation,
            arrivalStation,
            durationMinutes,
            companyId: company.id,
        },
    });
    return res.status(201).json(line);
}
async function updateLine(req, res) {
    const { lineId, name, departureStation, arrivalStation } = req.body;
    if (!lineId) {
        return res.status(400).json({ error: "lineId est requis" });
    }
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const line = await prisma_1.prisma.line.findFirst({ where: { id: lineId, companyId: company.id } });
    if (!line) {
        return res.status(404).json({ error: "Ligne introuvable" });
    }
    const nextDeparture = departureStation ?? line.departureStation;
    const nextArrival = arrivalStation ?? line.arrivalStation;
    if (nextDeparture === nextArrival) {
        return res.status(400).json({ error: "Les deux gares doivent être différentes" });
    }
    if (!(0, geography_service_1.isKnownStation)(nextDeparture) || !(0, geography_service_1.isKnownStation)(nextArrival)) {
        return res.status(400).json({ error: "Gare inconnue du réseau" });
    }
    // recalcul systématique : sinon on contournerait la règle par une modification
    const nextDuration = (0, geography_service_1.durationBetween)(nextDeparture, nextArrival);
    const updated = await prisma_1.prisma.line.update({
        where: { id: lineId },
        data: {
            ...(name !== undefined ? { name } : {}),
            departureStation: nextDeparture,
            arrivalStation: nextArrival,
            durationMinutes: nextDuration,
        },
    });
    return res.json(updated);
}
async function deleteLine(req, res) {
    const { lineId } = req.body;
    if (!lineId) {
        return res.status(400).json({ error: "lineId est requis" });
    }
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const line = await prisma_1.prisma.line.findFirst({ where: { id: lineId, companyId: company.id } });
    if (!line) {
        return res.status(404).json({ error: "Ligne introuvable" });
    }
    // les trains affectés à cette ligne sont libérés avant suppression (sans perdre
    // leur statut "en panne" si c'était le cas, pour ne pas les faire passer inaperçus)
    await prisma_1.prisma.$transaction([
        prisma_1.prisma.train.updateMany({
            where: { lineId, status: { not: "MAINTENANCE" } },
            data: { lineId: null, status: "IDLE", progress: 0, departedAt: null },
        }),
        prisma_1.prisma.train.updateMany({
            where: { lineId, status: "MAINTENANCE" },
            data: { lineId: null, progress: 0, departedAt: null },
        }),
        prisma_1.prisma.line.delete({ where: { id: lineId } }),
    ]);
    return res.json({ success: true });
}
async function listMyLines(req, res) {
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const lines = await prisma_1.prisma.line.findMany({
        where: { companyId: company.id },
        include: { trains: true },
    });
    return res.json(lines);
}
