"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SPONSOR_TITLE = exports.REFERRAL_MILESTONES = exports.QUALIFYING_GRADE_ID = void 0;
exports.countQualifiedReferrals = countQualifiedReferrals;
exports.processReferralMilestones = processReferralMilestones;
const prisma_1 = require("../prisma");
const leaderboard_service_1 = require("./leaderboard.service");
/* Un filleul ne compte vers les paliers qu'une fois le grade « Gestionnaire confirmé »
   atteint (3 rames, 2 lignes, 1000 pi. de recettes cumulées). La prime immédiate de
   150 pi., elle, reste acquise dès que le filleul a un train et une ligne.

   C'est ce seuil qui protège le système : fabriquer un faux compte ne rapporte un
   palier qu'après l'avoir réellement joué un bon moment — plus long que de jouer
   normalement, donc sans intérêt. */
exports.QUALIFYING_GRADE_ID = 1;
exports.REFERRAL_MILESTONES = [
    { count: 3, reward: "depot", label: "Un emplacement de dépôt supplémentaire" },
    { count: 5, reward: "title", label: "Titre « Recruteur du rail »" },
    { count: 10, reward: "express", label: "Une rame Express offerte" },
];
exports.SPONSOR_TITLE = "Recruteur du rail"; // « Chef de réseau » est déjà un grade de carrière : deux sens pour un nom embrouille
/* Le tableau de bord se rafraîchit toutes les dix secondes et demande la
   progression de parrainage à chaque fois. Recalculer les grades de tout le
   réseau à cette cadence, pour chaque joueur connecté, écraserait la base pour
   un chiffre qui ne bouge qu'en heures. Une minute de cache suffit. */
const QUALIFIED_TTL_MS = 60000;
let qualifiedCache = null;
/* Filleuls qualifiés par parrain : sert au calcul des paliers et à l'affichage
   de la progression côté joueur. */
async function countQualifiedReferrals(fresh = false) {
    if (!fresh && qualifiedCache && Date.now() - qualifiedCache.at < QUALIFIED_TTL_MS) {
        return qualifiedCache.map;
    }
    const rows = await (0, leaderboard_service_1.buildLeaderRows)();
    const gradeById = new Map(rows.map((r) => [r.id, r.gradeId]));
    const referred = await prisma_1.prisma.company.findMany({
        where: { referredById: { not: null } },
        select: { id: true, referredById: true },
    });
    const qualified = new Map();
    referred.forEach((r) => {
        if (!r.referredById)
            return;
        if ((gradeById.get(r.id) ?? 0) >= exports.QUALIFYING_GRADE_ID) {
            qualified.set(r.referredById, (qualified.get(r.referredById) ?? 0) + 1);
        }
    });
    qualifiedCache = { at: Date.now(), map: qualified };
    return qualified;
}
async function processReferralMilestones() {
    // le job travaille sur des chiffres frais : c'est lui qui distribue les lots
    const qualified = await countQualifiedReferrals(true);
    if (qualified.size === 0)
        return;
    for (const [sponsorId, count] of qualified) {
        const sponsor = await prisma_1.prisma.company.findUnique({
            where: { id: sponsorId },
            select: { id: true, referralMilestone: true, maxTrains: true, _count: { select: { trains: true } } },
        });
        if (!sponsor)
            continue;
        let granted = sponsor.referralMilestone;
        let maxTrains = sponsor.maxTrains;
        let trainCount = sponsor._count.trains;
        for (const milestone of exports.REFERRAL_MILESTONES) {
            if (count < milestone.count || granted >= milestone.count)
                continue;
            if (milestone.reward === "depot") {
                maxTrains += 1;
                await prisma_1.prisma.company.update({ where: { id: sponsorId }, data: { maxTrains } });
            }
            if (milestone.reward === "title") {
                await prisma_1.prisma.company.update({ where: { id: sponsorId }, data: { title: exports.SPONSOR_TITLE } });
            }
            if (milestone.reward === "express") {
                trainCount += 1;
                // la rame offerte s'ajoute au dépôt : on pousse la capacité avec elle
                // pour ne pas laisser la flotte afficher un effectif au-dessus du maximum
                maxTrains += 1;
                await prisma_1.prisma.company.update({ where: { id: sponsorId }, data: { maxTrains } });
                await prisma_1.prisma.train.create({
                    data: { name: `Rame ${trainCount}`, model: "EXPRESS", companyId: sponsorId },
                });
            }
            granted = milestone.count;
            await prisma_1.prisma.company.update({
                where: { id: sponsorId },
                data: { referralMilestone: granted },
            });
            // trace au grand livre : c'est le canal que le joueur consulte déjà
            await prisma_1.prisma.transaction.create({
                data: {
                    companyId: sponsorId,
                    type: "PARRAINAGE",
                    amount: 0,
                    description: `Palier de parrainage atteint (${milestone.count} filleuls) — ${milestone.label}`,
                },
            });
        }
    }
}
