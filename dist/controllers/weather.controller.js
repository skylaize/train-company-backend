"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEATHER_LABELS = void 0;
exports.getCurrentWeather = getCurrentWeather;
const prisma_1 = require("../prisma");
exports.WEATHER_LABELS = {
    BROUILLARD: "Brouillard sur le réseau — trains ralentis",
    CANICULE: "Canicule — usure du matériel accélérée",
    VERGLAS: "Verglas — risque de retard accru",
};
async function getCurrentWeather(_req, res) {
    const active = await prisma_1.prisma.weatherEvent.findFirst({
        where: { endsAt: { gt: new Date() } },
        orderBy: { startedAt: "desc" },
    });
    if (!active) {
        return res.json({ type: "CLAIR", label: null, endsAt: null });
    }
    return res.json({ type: active.type, label: exports.WEATHER_LABELS[active.type], endsAt: active.endsAt });
}
