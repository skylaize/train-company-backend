import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { buildLeaderRows } from "../services/leaderboard.service";

/* Douze modèles au lieu de trois : avec trois, le défi revenait tous les deux
   jours et cessait d'être un rendez-vous. Chacun porte un grade minimum, pour
   ne pas demander six livraisons à quelqu'un qui n'a qu'une rame, ni « créer
   une ligne » à un réseau qui en compte déjà quinze. */
const TEMPLATES: {
  type: string;
  target: number;
  reward: number;
  label: string;
  minGradeId: number;
}[] = [
  // --- accessibles dès le départ ---
  { type: "LIVRAISONS", target: 1, reward: 90, label: "Livrer un contrat de fret aujourd'hui", minGradeId: 0 },
  { type: "REPARATIONS", target: 1, reward: 100, label: "Réparer une rame aujourd'hui", minGradeId: 0 },
  { type: "NOUVELLE_LIGNE", target: 1, reward: 80, label: "Créer une nouvelle ligne aujourd'hui", minGradeId: 0 },
  { type: "TRAJETS", target: 5, reward: 110, label: "Effectuer 5 trajets voyageurs aujourd'hui", minGradeId: 0 },
  { type: "RECETTES", target: 400, reward: 120, label: "Encaisser 400 pi. de recettes aujourd'hui", minGradeId: 0 },

  // --- une fois la compagnie lancée ---
  { type: "LIVRAISONS", target: 3, reward: 200, label: "Livrer 3 contrats de fret aujourd'hui", minGradeId: 1 },
  { type: "TRAJETS", target: 12, reward: 180, label: "Effectuer 12 trajets voyageurs aujourd'hui", minGradeId: 1 },
  { type: "ACHAT_RAME", target: 1, reward: 150, label: "Mettre une nouvelle rame en service aujourd'hui", minGradeId: 1 },
  { type: "FRET_FRAGILE", target: 1, reward: 220, label: "Livrer une cargaison fragile aujourd'hui", minGradeId: 1 },
  { type: "RECETTES", target: 1200, reward: 260, label: "Encaisser 1 200 pi. de recettes aujourd'hui", minGradeId: 1 },

  // --- pour les réseaux installés ---
  { type: "ORDRE_MISSION", target: 1, reward: 300, label: "Honorer un ordre de donneur d'ordre aujourd'hui", minGradeId: 2 },
  { type: "LIVRAISONS", target: 6, reward: 380, label: "Livrer 6 contrats de fret aujourd'hui", minGradeId: 2 },

  // --- marché des marchandises, une fois l'entrepôt envisageable ---
  { type: "REVENTE", target: 1, reward: 170, label: "Revendre une marchandise avec bénéfice aujourd'hui", minGradeId: 1 },
  { type: "REVENTE", target: 3, reward: 340, label: "Réussir 3 reventes bénéficiaires aujourd'hui", minGradeId: 2 },
  { type: "CHANTIER", target: 1, reward: 250, label: "Mener un chantier à son terme aujourd'hui", minGradeId: 1 },
];

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function startOfToday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function computeProgress(companyId: string, type: string): Promise<number> {
  const since = startOfToday();
  switch (type) {
    case "LIVRAISONS":
      return prisma.transaction.count({ where: { companyId, type: "FRET", createdAt: { gte: since } } });
    case "REPARATIONS":
      return prisma.transaction.count({ where: { companyId, type: "REPARATION", createdAt: { gte: since } } });
    case "NOUVELLE_LIGNE":
      return prisma.line.count({ where: { companyId, createdAt: { gte: since } } });
    case "TRAJETS":
      return prisma.transaction.count({ where: { companyId, type: "REVENU_LIGNE", createdAt: { gte: since } } });
    case "ACHAT_RAME":
      return prisma.train.count({ where: { companyId, purchasedAt: { gte: since } } });
    case "FRET_FRAGILE":
      return prisma.contract.count({
        where: { companyId, risky: true, status: "LIVREE", createdAt: { gte: since } },
      });
    case "REVENTE": {
      /* Seules les reventes bénéficiaires comptent : revendre à perte pour
         cocher un défi serait une ligne de conduite absurde à encourager.
         Le gain est inscrit entre parenthèses dans le libellé de l'écriture. */
      const sales = await prisma.transaction.findMany({
        where: { companyId, type: "VENTE_FRET", createdAt: { gte: since } },
        select: { description: true },
      });
      return (sales as Array<{ description: string }>).filter((t) => {
        const m = t.description.match(/\(([-+]?\d+) pi\.\)$/);
        return m ? Number(m[1]) > 0 : false;
      }).length;
    }
    case "CHANTIER":
      return prisma.construction.count({
        where: { companyId, done: true, endsAt: { gte: since } },
      });
    case "ORDRE_MISSION":
      return prisma.mission.count({ where: { companyId, status: "REUSSIE", createdAt: { gte: since } } });
    case "RECETTES": {
      // seul défi mesuré en pièces : on additionne les recettes du jour
      const agg = await prisma.transaction.aggregate({
        where: { companyId, amount: { gt: 0 }, type: { not: "FONDATION" }, createdAt: { gte: since } },
        _sum: { amount: true },
      });
      return agg._sum.amount ?? 0;
    }
    default:
      return 0;
  }
}

export async function getMyDailyChallenge(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const date = todayKey();

  let challenge = await prisma.dailyChallenge.findUnique({
    where: { companyId_date: { companyId: company.id, date } },
  });

  if (!challenge) {
    /* On ne tire que parmi les défis à la portée du joueur. Sans ce filtre, un
       débutant pouvait tomber sur « livrer 6 contrats » et voir son rendez-vous
       quotidien échouer d'office. */
    const rows = await buildLeaderRows();
    const gradeId = rows.find((r) => r.id === company.id)?.gradeId ?? 0;
    const pool = TEMPLATES.filter((t) => t.minGradeId <= gradeId);
    const template = pool[Math.floor(Math.random() * pool.length)];
    challenge = await prisma.dailyChallenge.create({
      data: { companyId: company.id, date, type: template.type, target: template.target, reward: template.reward },
    });
  }

  /* Plusieurs modèles partagent un même type avec des cibles différentes :
     retrouver le libellé sur le type seul afficherait le mauvais objectif. */
  const template =
    TEMPLATES.find((t) => t.type === challenge!.type && t.target === challenge!.target) ??
    TEMPLATES.find((t) => t.type === challenge!.type)!;
  const progress = await computeProgress(company.id, challenge.type);

  return res.json({
    type: challenge.type,
    label: template.label,
    target: challenge.target,
    reward: challenge.reward,
    progress: Math.min(progress, challenge.target),
    completed: progress >= challenge.target,
    claimed: challenge.claimed,
  });
}

export async function claimDailyChallenge(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  const date = todayKey();
  const challenge = await prisma.dailyChallenge.findUnique({
    where: { companyId_date: { companyId: company.id, date } },
  });

  if (!challenge) {
    return res.status(404).json({ error: "Aucun défi actif aujourd'hui" });
  }
  if (challenge.claimed) {
    return res.status(409).json({ error: "Récompense déjà récupérée" });
  }

  const progress = await computeProgress(company.id, challenge.type);
  if (progress < challenge.target) {
    return res.status(409).json({ error: "Défi pas encore terminé" });
  }

  const template = TEMPLATES.find((t) => t.type === challenge.type)!;

  await prisma.$transaction([
    prisma.dailyChallenge.update({ where: { id: challenge.id }, data: { claimed: true } }),
    prisma.company.update({ where: { id: company.id }, data: { balance: { increment: challenge.reward } } }),
    prisma.transaction.create({
      data: {
        companyId: company.id,
        type: "DEFI_QUOTIDIEN",
        amount: challenge.reward,
        description: `Défi quotidien accompli : ${template.label}`,
      },
    }),
  ]);

  return res.json({ success: true });
}
