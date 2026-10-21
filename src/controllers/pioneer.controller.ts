import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";

/* ============================================================
   2.1.2 : les 200 pionniers.

   Le réseau a passé les 200 joueurs. Les 200 premières compagnies reçoivent
   un billet numéroté dans l'ordre de leur fondation (« Pionnier n° 37 / 200 »),
   et tout le monde peut télécharger la grande carte : les réseaux des 200
   superposés sur une seule carte de France, avec leurs noms en bordure.

   Le numéro est écrit en base par la migration : il ne bouge plus, même si
   une compagnie plus ancienne disparaît.
   ============================================================ */

export const PIONEER_COUNT = 200;

/* une nouvelle compagnie prend une place de pionnier tant qu'il en reste */
export async function claimPioneerNumber(companyId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const top = await prisma.company.aggregate({ _max: { pioneerNumber: true } });
    const next = (top._max.pioneerNumber ?? 0) + 1;
    if (next > PIONEER_COUNT) return;
    try {
      await prisma.company.update({ where: { id: companyId }, data: { pioneerNumber: next } });
      return;
    } catch {
      // deux fondations au même instant : la contrainte unique tranche, on retente
    }
  }
}

export async function getMyPioneer(req: AuthRequest, res: Response) {
  const company = await prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { name: true, liveryColor: true, createdAt: true, pioneerNumber: true },
  });
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  return res.json({
    number: company.pioneerNumber,
    total: PIONEER_COUNT,
    company: company.name,
    livery: company.liveryColor,
    foundedAt: company.createdAt,
  });
}

export async function getPioneerMap(_req: AuthRequest, res: Response) {
  const companies = await prisma.company.findMany({
    where: { pioneerNumber: { not: null } },
    orderBy: { pioneerNumber: "asc" },
    select: {
      pioneerNumber: true,
      name: true,
      liveryColor: true,
      lines: { select: { departureStation: true, stops: true, arrivalStation: true } },
    },
  });
  return res.json({
    total: PIONEER_COUNT,
    companies: companies.map((c) => ({
      n: c.pioneerNumber,
      name: c.name,
      livery: c.liveryColor,
      lines: c.lines.map((l) => [l.departureStation, ...(l.stops ?? []), l.arrivalStation]),
    })),
  });
}
