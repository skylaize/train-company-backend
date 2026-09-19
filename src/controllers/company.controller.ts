import { Response } from "express";
import { Prisma } from "@prisma/client";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { computeReputation } from "../services/reputation.service";

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

export async function updateCompany(req: AuthRequest, res: Response) {
  const { name, liveryColor, tutorialSeen } = req.body;

  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Aucune compagnie trouvée pour cet utilisateur" });
  }

  if (name !== undefined && !name.trim()) {
    return res.status(400).json({ error: "Le nom ne peut pas être vide" });
  }

  const updated = await prisma.company.update({
    where: { id: company.id },
    data: {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(liveryColor !== undefined ? { liveryColor } : {}),
      ...(tutorialSeen !== undefined ? { tutorialSeen: Boolean(tutorialSeen) } : {}),
    },
  });

  return res.json(updated);
}

const MAX_FLEET_CAP = 6; // capacité maximale du dépôt en V1

export async function expandFleet(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({ where: { ownerId: req.userId as string } });
  if (!company) {
    return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  }

  if (company.maxTrains >= MAX_FLEET_CAP) {
    return res.status(409).json({ error: "Capacité maximale du dépôt atteinte" });
  }

  const cost = company.maxTrains * 200;
  if (company.balance < cost) {
    return res.status(409).json({ error: `Trésorerie insuffisante (agrandissement : ${cost} pièces)` });
  }

  const [updated] = await prisma.$transaction([
    prisma.company.update({
      where: { id: company.id },
      data: { maxTrains: { increment: 1 }, balance: { decrement: cost } },
    }),
    prisma.transaction.create({
      data: {
        companyId: company.id,
        type: "EXPANSION_FLOTTE",
        amount: -cost,
        description: `Agrandissement du dépôt (+1 place, capacité ${company.maxTrains + 1})`,
      },
    }),
  ]);

  return res.json(updated);
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

  return res.json({ ...company, reputation });
}
