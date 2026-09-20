"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeExpiredContracts = removeExpiredContracts;
exports.ensureMarketStocked = ensureMarketStocked;
exports.listMarket = listMarket;
exports.listMyContracts = listMyContracts;
exports.acceptContract = acceptContract;
const prisma_1 = require("../prisma");
const mission_service_1 = require("../services/mission.service");
const market_service_1 = require("../services/market.service");
async function getOwnedCompanyOrFail(userId) {
    return prisma_1.prisma.company.findUnique({ where: { ownerId: userId } });
}
// Modèles d'offres tirées au sort pour réapprovisionner le marché
const CARGO_TEMPLATES = [
    { cargoType: "Céréales", originStation: "Chartres", destinationStation: "Le Mans", durationMinutes: 6, reward: 120, risky: false },
    { cargoType: "Acier", originStation: "Le Creusot", destinationStation: "Dijon", durationMinutes: 8, reward: 180, risky: false },
    { cargoType: "Conteneurs", originStation: "Le Havre", destinationStation: "Rouen", durationMinutes: 4, reward: 90, risky: false },
    { cargoType: "Bois", originStation: "Nancy", destinationStation: "Metz", durationMinutes: 5, reward: 100, risky: false },
    { cargoType: "Automobiles", originStation: "Sochaux", destinationStation: "Mulhouse", durationMinutes: 7, reward: 150, risky: false },
    { cargoType: "Produits chimiques", originStation: "Lyon", destinationStation: "Grenoble", durationMinutes: 6, reward: 140, risky: false },
    // marchandises fragiles : récompense nettement supérieure, mais risque de dommage en cours de route
    { cargoType: "Verre soufflé", originStation: "Nancy", destinationStation: "Strasbourg", durationMinutes: 5, reward: 230, risky: true },
    { cargoType: "Œuvres d'art", originStation: "Paris", destinationStation: "Lyon", durationMinutes: 8, reward: 340, risky: true },
    { cargoType: "Produits pharmaceutiques réfrigérés", originStation: "Strasbourg", destinationStation: "Mulhouse", durationMinutes: 4, reward: 190, risky: true },
];
/* Le marché est commun à tout le réseau : on le garnit pour le plus exigeant
   des joueurs connectés. Un abonné voit six offres, un gratuit les trois plus
   anciennes — plus de choix, pas de meilleur tarif. */
const MIN_MARKET_SIZE = 3;
const PREMIUM_MARKET_SIZE = 6;
const EXPIRY_MINUTES = 5; // durée de vie d'une offre non acceptée sur le marché
async function removeExpiredContracts() {
    await prisma_1.prisma.contract.deleteMany({
        where: { status: "DISPONIBLE", companyId: null, expiresAt: { lt: new Date() } },
    });
}
async function ensureMarketStocked() {
    const availableContracts = await prisma_1.prisma.contract.findMany({
        where: { status: "DISPONIBLE", companyId: null },
        select: { cargoType: true },
    });
    const presentTypes = new Set(availableContracts.map((c) => c.cargoType));
    /* Marchandises réclamées par un ordre de mission en cours et absentes du
       marché. Sans cette garantie, un joueur peut accepter un ordre portant sur
       de l'acier et ne jamais voir un seul contrat d'acier — il perdrait de la
       réputation sans avoir commis la moindre erreur. */
    const wanted = [...(await (0, mission_service_1.requiredCargoTypes)())].filter((t) => !presentTypes.has(t) && CARGO_TEMPLATES.some((c) => c.cargoType === t));
    /* Le marché s'étend au-delà de son minimum si des ordres attendent une
       marchandise : un marché « plein » d'autre chose bloquerait les missions. */
    const toCreate = Math.max(PREMIUM_MARKET_SIZE - availableContracts.length, wanted.length);
    if (toCreate <= 0)
        return;
    for (let i = 0; i < toCreate; i++) {
        let template;
        // les marchandises réclamées passent d'abord
        while (wanted.length > 0 && !template) {
            const need = wanted.shift();
            template = CARGO_TEMPLATES.find((t) => t.cargoType === need);
        }
        if (!template) {
            // on évite de proposer un modèle de marchandise déjà visible sur le marché,
            // pour ne pas donner l'impression que les offres se dupliquent
            const pool = CARGO_TEMPLATES.filter((t) => !presentTypes.has(t.cargoType));
            const candidates = pool.length > 0 ? pool : CARGO_TEMPLATES;
            template = candidates[Math.floor(Math.random() * candidates.length)];
        }
        presentTypes.add(template.cargoType);
        await prisma_1.prisma.contract.create({
            data: { ...template, expiresAt: new Date(Date.now() + EXPIRY_MINUTES * 60000) },
        });
    }
}
async function listMarket(req, res) {
    await removeExpiredContracts();
    await ensureMarketStocked();
    const company = await prisma_1.prisma.company.findUnique({
        where: { ownerId: req.userId },
        select: { isPremium: true },
    });
    const contracts = await prisma_1.prisma.contract.findMany({
        where: { status: "DISPONIBLE", companyId: null },
        orderBy: { createdAt: "asc" },
        take: company?.isPremium ? PREMIUM_MARKET_SIZE : MIN_MARKET_SIZE,
    });
    /* Le cours du jour est joint à chaque offre : sans lui, le joueur devrait
       ouvrir une autre page pour savoir si la marchandise proposée paie
       au-dessus ou en dessous de sa valeur normale. */
    const index = await (0, market_service_1.getCargoIndexMap)();
    const withPrices = contracts.map((c) => {
        const i = index.get(c.cargoType);
        const multiplier = i === undefined ? 1 : (0, market_service_1.freightMultiplier)(i);
        return {
            ...c,
            marketIndex: i === undefined ? null : Number(i.toFixed(3)),
            // récompense réellement attendue, cours compris — c'est ce chiffre qui décide
            effectiveReward: Math.round(c.reward * multiplier),
            marketDelta: Math.round((multiplier - 1) * 100),
        };
    });
    return res.json(withPrices);
}
async function listMyContracts(req, res) {
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const contracts = await prisma_1.prisma.contract.findMany({
        where: { companyId: company.id },
        include: { train: true },
        orderBy: { createdAt: "desc" },
    });
    return res.json(contracts);
}
const INSURANCE_PREMIUM_RATIO = 0.15; // 15% de la récompense, payé d'avance, non remboursable
async function acceptContract(req, res) {
    const { contractId, trainId, insured } = req.body;
    if (!contractId || !trainId) {
        return res.status(400).json({ error: "contractId et trainId sont requis" });
    }
    const company = await getOwnedCompanyOrFail(req.userId);
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const contract = await prisma_1.prisma.contract.findUnique({ where: { id: contractId } });
    if (!contract || contract.status !== "DISPONIBLE" || contract.companyId) {
        return res.status(409).json({ error: "Ce contrat n'est plus disponible" });
    }
    if (contract.expiresAt && contract.expiresAt < new Date()) {
        await prisma_1.prisma.contract.delete({ where: { id: contractId } });
        return res.status(409).json({ error: "Ce contrat vient d'expirer" });
    }
    const train = await prisma_1.prisma.train.findFirst({ where: { id: trainId, companyId: company.id } });
    if (!train) {
        return res.status(404).json({ error: "Train introuvable" });
    }
    if (train.status !== "IDLE" || train.lineId) {
        return res.status(409).json({ error: "Ce train n'est pas disponible (déjà en service)" });
    }
    if (train.wear >= 100) {
        return res.status(409).json({ error: "Ce train doit être réparé avant de pouvoir circuler" });
    }
    const wantsInsurance = Boolean(insured);
    if (wantsInsurance && !contract.risky) {
        return res.status(400).json({ error: "Seules les cargaisons fragiles peuvent être assurées" });
    }
    const premium = wantsInsurance ? Math.round(contract.reward * INSURANCE_PREMIUM_RATIO) : 0;
    if (wantsInsurance && company.balance < premium) {
        return res.status(409).json({ error: `Trésorerie insuffisante pour la prime d'assurance (${premium} pièces)` });
    }
    const updates = [
        prisma_1.prisma.contract.update({
            where: { id: contractId },
            data: { companyId: company.id, trainId, status: "EN_COURS", acceptedAt: new Date(), insured: wantsInsurance },
        }),
        prisma_1.prisma.train.update({
            where: { id: trainId },
            data: { status: "EN_ROUTE", progress: 0, departedAt: new Date() },
        }),
    ];
    if (wantsInsurance) {
        updates.push(prisma_1.prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: premium } } }), prisma_1.prisma.transaction.create({
            data: {
                companyId: company.id,
                type: "FRET",
                amount: -premium,
                description: `Prime d'assurance : ${contract.cargoType}`,
            },
        }));
    }
    const [updatedContract] = await prisma_1.prisma.$transaction(updates);
    return res.status(201).json(updatedContract);
}
