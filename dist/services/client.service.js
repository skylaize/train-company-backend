"use strict";
/* ============================================================
   Donneurs d'ordre.

   Chaque client est rattaché à des marchandises qui existent déjà dans
   CARGO_TEMPLATES (contract.controller.ts) : le système ne crée pas un
   second circuit économique à côté du fret, il donne une raison de
   préférer un contrat à un autre.

   La récompense de mission n'est pas le vrai enjeu. Le vrai enjeu est la
   réputation, qui majore le tarif de TOUTES les cargaisons du client —
   se spécialiser devient une stratégie, pas une collection de primes.
   ============================================================ */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FAILURE_PENALTY = exports.REPUTATION_MAX = exports.CLIENT_LEVELS = exports.CLIENTS = void 0;
exports.clientById = clientById;
exports.levelFromReputation = levelFromReputation;
exports.nextLevel = nextLevel;
exports.cargoBonus = cargoBonus;
exports.CLIENTS = [
    {
        id: "ACIERIES",
        name: "Aciéries de Lorraine",
        sector: "Industrie lourde",
        city: "Metz",
        cargoTypes: ["Acier", "Automobiles", "Bois"],
        minGradeId: 0,
        color: "#38bdf8",
        colorPaper: "#2d6a8c",
    },
    {
        id: "PORT",
        name: "Port autonome du Havre",
        sector: "Maritime",
        city: "Le Havre",
        cargoTypes: ["Conteneurs", "Céréales"],
        minGradeId: 0,
        color: "#10b981",
        colorPaper: "#1f5c4d",
    },
    {
        id: "COOPERATIVE",
        name: "Coopérative de la Beauce",
        sector: "Agricole",
        city: "Chartres",
        cargoTypes: ["Céréales", "Bois"],
        minGradeId: 1,
        color: "#f59e0b",
        colorPaper: "#9a6516",
    },
    {
        id: "LABORATOIRES",
        name: "Laboratoires du Rhône",
        sector: "Chimie et pharmacie",
        city: "Lyon",
        cargoTypes: ["Produits chimiques", "Produits pharmaceutiques réfrigérés", "Verre soufflé"],
        minGradeId: 2,
        color: "#a78bfa",
        colorPaper: "#6b4f8f",
    },
];
function clientById(id) {
    return exports.CLIENTS.find((c) => c.id === id) ?? null;
}
/* Paliers de fidélité. Le bonus s'applique au paiement de chaque cargaison
   du client, mission ou non. */
exports.CLIENT_LEVELS = [
    { level: 0, from: 0, name: "Nouveau partenaire", bonus: 0 },
    { level: 1, from: 30, name: "Client régulier", bonus: 0.08 },
    { level: 2, from: 60, name: "Client privilégié", bonus: 0.15 },
    { level: 3, from: 100, name: "Affréteur historique", bonus: 0.25 },
];
function levelFromReputation(reputation) {
    let found = exports.CLIENT_LEVELS[0];
    for (const l of exports.CLIENT_LEVELS)
        if (reputation >= l.from)
            found = l;
    return found;
}
function nextLevel(reputation) {
    return exports.CLIENT_LEVELS.find((l) => l.from > reputation) ?? null;
}
/* Majoration accordée à une cargaison donnée, tous clients confondus.
   Si deux clients achètent la même marchandise (les céréales intéressent le
   Port ET la Coopérative), c'est la meilleure relation qui s'applique :
   pénaliser le joueur parce qu'il a deux bons clients n'aurait aucun sens. */
function cargoBonus(cargoType, reputationByClient) {
    let best = 0;
    for (const client of exports.CLIENTS) {
        if (!client.cargoTypes.includes(cargoType))
            continue;
        const rep = reputationByClient.get(client.id) ?? 0;
        best = Math.max(best, levelFromReputation(rep).bonus);
    }
    return best;
}
exports.REPUTATION_MAX = 100;
exports.FAILURE_PENALTY = 6; // réputation perdue quand un ordre n'est pas honoré
