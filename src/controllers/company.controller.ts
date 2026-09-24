import { Response } from "express";
import { Prisma } from "@prisma/client";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { computeReputation } from "../services/reputation.service";
import { depotExpansionCost, upkeepPerTick } from "../services/upkeep.service";
import { depotBuildHours, activeConstruction, queuedConstruction, quoteFor, orderConstruction } from "../services/construction.service";
import { unlockedFor } from "../services/shop.service";
import { touchActivity } from "../services/report.service";
import { staffEffectsFor, repairCostPerPoint } from "../services/staff.service";

const REFERRAL_SIGNUP_BONUS = 100; // versé immédiatement au nouveau joueur qui utilise un code
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans caractères ambigus (0/O, 1/I...)

async function generateUniqueReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    const existing = await prisma.company.findUnique({ where: { referralCode: code } });
    if (!existing) return code;
  }
  throw new Error("Impossible de générer un code de parrainage unique");
}

export async function createCompany(req: AuthRequest, res: Response) {
  const { name, liveryColor, referralCode } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Le nom de la compagnie est requis" });
  }

  const existing = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (existing) {
    return res.status(409).json({ error: "Vous avez déjà une compagnie" });
  }

  // le code de parrainage est optionnel ; s'il est fourni, il doit correspondre à une compagnie existante
  let referrer: { id: string } | null = null;
  if (referralCode && typeof referralCode === "string") {
    referrer = await prisma.company.findUnique({
      where: { referralCode: referralCode.trim().toUpperCase() },
      select: { id: true },
    });
    // un code invalide n'empêche pas la création de compagnie, il est simplement ignoré
  }

  const newCode = await generateUniqueReferralCode();

  const company = await prisma.company.create({
    data: {
      name,
      liveryColor: liveryColor || "#f2a900",
      ownerId: req.userId as string,
      referralCode: newCode,
      referredById: referrer?.id ?? null,
    },
  });

  const foundationTransactions: Prisma.PrismaPromise<any>[] = [
    prisma.transaction.create({
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
    foundationTransactions.push(
      prisma.company.update({
        where: { id: company.id },
        data: { balance: { increment: REFERRAL_SIGNUP_BONUS } },
      }),
      prisma.transaction.create({
        data: {
          companyId: company.id,
          type: "PARRAINAGE",
          amount: REFERRAL_SIGNUP_BONUS,
          description: "Bonus de bienvenue (code de parrainage utilisé)",
        },
      })
    );
  }

  await prisma.$transaction(foundationTransactions);

  const finalCompany = await prisma.company.findUnique({ where: { id: company.id } });
  return res.status(201).json(finalCompany);
}

/* Livrées. La palette réservée doit être vérifiée ici : l'interface grise les
   boutons, mais rien n'empêche d'envoyer la couleur directement à l'API. */
const LIVERY_FREE = ["#c99a3e", "#4f7fa3", "#5c8a68", "#a8483a", "#8a6ba3", "#c97a3e", "#f2a900"];
const LIVERY_PREMIUM = ["#0f766e", "#b91c1c", "#1e3a8a", "#7c2d12", "#4c1d95", "#065f46", "#9d174d", "#334155"];

function liveryAllowed(color: string, isPremium: boolean, fromShop: Set<string>) {
  const c = String(color).toLowerCase();
  if (LIVERY_FREE.includes(c)) return true;
  if (fromShop.has(c)) return true;
  return isPremium && LIVERY_PREMIUM.includes(c);
}

function mergeHint(current: string, id: string) {
  const list = (current || "").split(",").filter(Boolean);
  return list.includes(id) ? current : [...list, id].join(",");
}

export async function updateCompany(req: AuthRequest, res: Response) {
  const { name, liveryColor, tutorialSeen, theme, lastSeenVersion, seenHint, emblem, title, cabSkin } = req.body;

  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Aucune compagnie trouvée pour cet utilisateur" });
  }

  if (name !== undefined && !name.trim()) {
    return res.status(400).json({ error: "Le nom ne peut pas être vide" });
  }

  /* Tout ce qui se porte est vérifié contre ce que la compagnie possède
     vraiment : l'interface grise les choix non débloqués, mais rien n'empêche
     d'envoyer une valeur directement à l'API. */
  const unlocked = await unlockedFor(company.id);

  if (liveryColor !== undefined && !liveryAllowed(liveryColor, company.isPremium, unlocked.liveries)) {
    return res.status(403).json({ error: "Cette livrée n'est pas débloquée pour votre compagnie" });
  }
  // null retire l'emblème ou le titre ; une valeur doit avoir été débloquée
  if (emblem !== undefined && emblem !== null && !unlocked.emblems.has(String(emblem))) {
    return res.status(403).json({ error: "Cet emblème n'est pas débloqué pour votre compagnie" });
  }
  if (title !== undefined && title !== null && !unlocked.titles.has(String(title))) {
    return res.status(403).json({ error: "Ce titre n'est pas débloqué pour votre compagnie" });
  }
  if (cabSkin !== undefined && cabSkin !== null && !unlocked.cabSkins.has(String(cabSkin))) {
    return res.status(403).json({ error: "Ce matériel n'est pas débloqué" });
  }
  if (theme !== undefined && !unlocked.themes.has(String(theme))) {
    return res.status(403).json({ error: "Cet habillage n'est pas débloqué pour votre compagnie" });
  }

  const updated = await prisma.company.update({
    where: { id: company.id },
    data: {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(liveryColor !== undefined ? { liveryColor } : {}),
      ...(tutorialSeen !== undefined ? { tutorialSeen: Boolean(tutorialSeen) } : {}),
      // l'habillage a déjà été vérifié contre ce que la compagnie possède
      ...(theme !== undefined ? { theme: String(theme) } : {}),
      ...(emblem !== undefined ? { emblem: emblem === null ? null : String(emblem) } : {}),
      ...(title !== undefined ? { title: title === null ? null : String(title) } : {}),
      ...(cabSkin !== undefined ? { cabSkin: cabSkin === null ? null : String(cabSkin) } : {}),
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
export async function expandFleet(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  // même chemin que la page des chantiers : lancement immédiat, ou mise en file (Premium)
  const result = await orderConstruction(company.id, "DEPOT");
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  return res.status(201).json({ ...(result.construction as object), queued: result.queued });
}

export async function getMyCompany(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    include: { trains: true, lines: true },
  });

  if (!company) {
    return res.status(404).json({ error: "Aucune compagnie trouvée pour cet utilisateur" });
  }

  const reputation = await computeReputation(company.id);

  // dernière activité : sert au bilan de retour (Premium) et au bilan du matin
  await touchActivity(company as typeof company & { lastActiveAt: Date | null });

  /* Le joueur doit voir ce que coûte la place suivante et ce que son réseau lui
     coûte par heure : sans ces deux chiffres, l'entretien ressemble à une fuite
     de trésorerie inexpliquée. */
  const trainCount = company.trains.length;
  const TICKS_PER_HOUR = 120;

  /* Le chantier en cours voyage avec la compagnie : la flotte, le marché et la
     page des chantiers l'affichent tous, et aucun des trois ne doit avoir à le
     demander séparément. */
  const [construction, queuedChantier] = await Promise.all([
    activeConstruction(company.id),
    queuedConstruction(company.id),
  ]);
  // prix et durée de la prochaine place — après le chantier en cours s'il y en a un
  const depotQuote = await quoteFor(company.id, "DEPOT", construction ? construction.kind : null);

  /* Ce que la compagnie a débloqué, en boutique ou en jeu. Livré avec la
     compagnie plutôt que par un appel à part : la livrée, l'habillage, l'emblème
     et le titre en ont tous besoin, et ils ne doivent pas se contredire. */
  const [unlocked, staffFx] = await Promise.all([unlockedFor(company.id), staffEffectsFor(company.id)]);

  return res.json({
    ...company,
    reputation,
    // prix d'un point de réparation, pour que le bouton annonce le vrai montant
    repairCostPerPoint: repairCostPerPoint(staffFx),
    unlocked: {
      themes: [...unlocked.themes],
      emblems: [...unlocked.emblems],
      titles: [...unlocked.titles],
      liveries: [...unlocked.liveries],
    },
    nextDepotCost: depotQuote?.cost ?? depotExpansionCost(company.maxTrains, company.isPremium),
    nextDepotHours: depotQuote?.hours ?? depotBuildHours(company.maxTrains),
    construction,
    queuedConstruction: queuedChantier,
    canQueue: company.isPremium && Boolean(construction) && !queuedChantier,
    upkeepPerHour: upkeepPerTick(trainCount) * TICKS_PER_HOUR,
  });
}
