"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCompany = createCompany;
exports.updateCompany = updateCompany;
exports.expandFleet = expandFleet;
exports.getMyCompany = getMyCompany;
const prisma_1 = require("../prisma");
const reputation_service_1 = require("../services/reputation.service");
const upkeep_service_1 = require("../services/upkeep.service");
const construction_service_1 = require("../services/construction.service");
const REFERRAL_SIGNUP_BONUS = 100; // versé immédiatement au nouveau joueur qui utilise un code
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans caractères ambigus (0/O, 1/I...)
async function generateUniqueReferralCode() {
    for (let attempt = 0; attempt < 10; attempt++) {
        let code = "";
        for (let i = 0; i < 6; i++) {
            code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        }
        const existing = await prisma_1.prisma.company.findUnique({ where: { referralCode: code } });
        if (!existing)
            return code;
    }
    throw new Error("Impossible de générer un code de parrainage unique");
}
async function createCompany(req, res) {
    const { name, liveryColor, referralCode } = req.body;
    if (!name) {
        return res.status(400).json({ error: "Le nom de la compagnie est requis" });
    }
    const existing = await prisma_1.prisma.company.findUnique({ where: { ownerId: req.userId } });
    if (existing) {
        return res.status(409).json({ error: "Vous avez déjà une compagnie" });
    }
    // le code de parrainage est optionnel ; s'il est fourni, il doit correspondre à une compagnie existante
    let referrer = null;
    if (referralCode && typeof referralCode === "string") {
        referrer = await prisma_1.prisma.company.findUnique({
            where: { referralCode: referralCode.trim().toUpperCase() },
            select: { id: true },
        });
        // un code invalide n'empêche pas la création de compagnie, il est simplement ignoré
    }
    const newCode = await generateUniqueReferralCode();
    const company = await prisma_1.prisma.company.create({
        data: {
            name,
            liveryColor: liveryColor || "#f2a900",
            ownerId: req.userId,
            referralCode: newCode,
            referredById: referrer?.id ?? null,
        },
    });
    const foundationTransactions = [
        prisma_1.prisma.transaction.create({
            data: {
                companyId: company.id,
                type: "FONDATION",
                amount: company.balance,
                description: "Capital de fondation de la compagnie",
            },
        }),
    ];
    // bonus de bienvenue immédiat pour le nouveau joueur qui utilise un code de parrainage valide
    if (referrer) {
        foundationTransactions.push(prisma_1.prisma.company.update({
            where: { id: company.id },
            data: { balance: { increment: REFERRAL_SIGNUP_BONUS } },
        }), prisma_1.prisma.transaction.create({
            data: {
                companyId: company.id,
                type: "PARRAINAGE",
                amount: REFERRAL_SIGNUP_BONUS,
                description: "Bonus de bienvenue (code de parrainage utilisé)",
            },
        }));
    }
    await prisma_1.prisma.$transaction(foundationTransactions);
    const finalCompany = await prisma_1.prisma.company.findUnique({ where: { id: company.id } });
    return res.status(201).json(finalCompany);
}
/* Livrées. La palette réservée doit être vérifiée ici : l'interface grise les
   boutons, mais rien n'empêche d'envoyer la couleur directement à l'API. */
const LIVERY_FREE = ["#c99a3e", "#4f7fa3", "#5c8a68", "#a8483a", "#8a6ba3", "#c97a3e", "#f2a900"];
const LIVERY_PREMIUM = ["#0f766e", "#b91c1c", "#1e3a8a", "#7c2d12", "#4c1d95", "#065f46", "#9d174d", "#334155"];
function liveryAllowed(color, isPremium) {
    const c = String(color).toLowerCase();
    if (LIVERY_FREE.includes(c))
        return true;
    return isPremium && LIVERY_PREMIUM.includes(c);
}
function mergeHint(current, id) {
    const list = (current || "").split(",").filter(Boolean);
    return list.includes(id) ? current : [...list, id].join(",");
}
async function updateCompany(req, res) {
    const { name, liveryColor, tutorialSeen, theme, lastSeenVersion, seenHint } = req.body;
    const company = await prisma_1.prisma.company.findUnique({ where: { ownerId: req.userId } });
    if (!company) {
        return res.status(404).json({ error: "Aucune compagnie trouvée pour cet utilisateur" });
    }
    if (name !== undefined && !name.trim()) {
        return res.status(400).json({ error: "Le nom ne peut pas être vide" });
    }
    if (liveryColor !== undefined && !liveryAllowed(liveryColor, company.isPremium)) {
        return res.status(403).json({ error: "Cette livrée est réservée aux compagnies Premium" });
    }
    const updated = await prisma_1.prisma.company.update({
        where: { id: company.id },
        data: {
            ...(name !== undefined ? { name: name.trim() } : {}),
            ...(liveryColor !== undefined ? { liveryColor } : {}),
            ...(tutorialSeen !== undefined ? { tutorialSeen: Boolean(tutorialSeen) } : {}),
            // liste blanche : une valeur inconnue laisserait l'interface sans couleurs
            ...(theme === "sombre" || theme === "papier" ? { theme } : {}),
            ...(typeof lastSeenVersion === "string" && lastSeenVersion.length <= 20
                ? { lastSeenVersion }
                : {}),
            /* Les explications contextuelles sont marquées une par une. On stocke une
               liste séparée par des virgules plutôt qu'un tableau : une seule colonne,
               pas de table supplémentaire pour une poignée d'identifiants. */
            ...(typeof seenHint === "string" && /^[a-z-]{1,32}$/.test(seenHint)
                ? { hintsSeen: mergeHint(company.hintsSeen, seenHint) }
                : {}),
        },
    });
    return res.json(updated);
}
/* Plus de plafond : c'est le prix qui freine, pas une borne arbitraire.
   Une borne dure arrêtait net la progression ; un coût géométrique la ralentit
   sans jamais la fermer.

   L'agrandissement passe par un CHANTIER : on paie à la
   commande, la place arrive quelques dizaines de minutes plus tard, et on ne
   peut en mener qu'un à la fois. Sans cela, une compagnie assise sur 30 000
   pièces convertissait sa trésorerie en dix places d'un seul clic — l'argent
   était la seule contrainte, et elle ne contraignait plus personne. */
async function expandFleet(req, res) {
    const company = await prisma_1.prisma.company.findUnique({ where: { ownerId: req.userId } });
    if (!company) {
        return res.status(404).json({ error: "Créez d'abord votre compagnie" });
    }
    const running = await prisma_1.prisma.construction.findFirst({
        where: { companyId: company.id, done: false },
    });
    if (running) {
        return res.status(409).json({ error: "Un chantier est déjà en cours" });
    }
    const cost = (0, upkeep_service_1.depotExpansionCost)(company.maxTrains, company.isPremium);
    if (company.balance < cost) {
        return res.status(409).json({ error: `Trésorerie insuffisante (agrandissement : ${cost} pièces)` });
    }
    const hours = (0, construction_service_1.depotBuildHours)(company.maxTrains);
    const label = `Agrandissement du dépôt (${company.maxTrains + 1} places)`;
    const [construction] = await prisma_1.prisma.$transaction([
        prisma_1.prisma.construction.create({
            data: {
                companyId: company.id,
                kind: "DEPOT",
                label,
                cost,
                endsAt: new Date(Date.now() + hours * 3600000),
            },
        }),
        prisma_1.prisma.company.update({ where: { id: company.id }, data: { balance: { decrement: cost } } }),
        prisma_1.prisma.transaction.create({
            data: {
                companyId: company.id,
                type: "CHANTIER",
                amount: -cost,
                description: `${label} — chantier lancé`,
            },
        }),
    ]);
    return res.status(201).json(construction);
}
async function getMyCompany(req, res) {
    const company = await prisma_1.prisma.company.findUnique({
        where: { ownerId: req.userId },
        include: { trains: true, lines: true },
    });
    if (!company) {
        return res.status(404).json({ error: "Aucune compagnie trouvée pour cet utilisateur" });
    }
    const reputation = await (0, reputation_service_1.computeReputation)(company.id);
    /* Le joueur doit voir ce que coûte la place suivante et ce que son réseau lui
       coûte par heure : sans ces deux chiffres, l'entretien ressemble à une fuite
       de trésorerie inexpliquée. */
    const trainCount = company.trains.length;
    const TICKS_PER_HOUR = 120;
    /* Le chantier en cours voyage avec la compagnie : la flotte, le marché et la
       page des chantiers l'affichent tous, et aucun des trois ne doit avoir à le
       demander séparément. */
    const construction = await prisma_1.prisma.construction.findFirst({
        where: { companyId: company.id, done: false },
        orderBy: { startedAt: "desc" },
    });
    return res.json({
        ...company,
        reputation,
        nextDepotCost: (0, upkeep_service_1.depotExpansionCost)(company.maxTrains, company.isPremium),
        nextDepotHours: (0, construction_service_1.depotBuildHours)(company.maxTrains),
        construction,
        upkeepPerHour: (0, upkeep_service_1.upkeepPerTick)(trainCount) * TICKS_PER_HOUR,
    });
}
