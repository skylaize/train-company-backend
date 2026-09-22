import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { profitability, windowReport, marketMovers } from "../services/report.service";

async function companyOf(req: AuthRequest) {
  return prisma.company.findUnique({ where: { ownerId: req.userId as string } });
}

/* Rentabilité détaillée — Premium. Un joueur gratuit reçoit une réponse
   « verrouillée » plutôt qu'une erreur : la page affiche alors ce qu'il
   verrait, sans les chiffres. */
export async function getProfitability(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  if (!company.isPremium) return res.json({ locked: true });
  return res.json({ locked: false, ...(await profitability(company.id)) });
}

/* Bilan de l'absence en attente, s'il y en a un. Le joueur gratuit en voit
   l'essentiel — durée et solde — et le détail est réservé au Premium. */
export async function getAbsenceReport(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const c = company as typeof company & {
    absenceFrom: Date | null;
    absenceTo: Date | null;
    absenceFromBalance: number | null;
    absenceToBalance: number | null;
  };
  if (!c.absenceFrom || !c.absenceTo) return res.json({ pending: false });

  const from = new Date(c.absenceFrom);
  const to = new Date(c.absenceTo);
  const base = {
    pending: true,
    from,
    to,
    hours: Math.round((to.getTime() - from.getTime()) / 3600_000),
    net: (c.absenceToBalance ?? company.balance) - (c.absenceFromBalance ?? company.balance),
  };

  if (!company.isPremium) return res.json({ ...base, locked: true });

  const [report, movers] = await Promise.all([windowReport(company.id, from, to), marketMovers(from)]);
  return res.json({ ...base, locked: false, ...report, movers });
}

export async function dismissAbsenceReport(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  await prisma.company.update({
    where: { id: company.id },
    data: { absenceFrom: null, absenceTo: null, absenceFromBalance: null, absenceToBalance: null },
  });
  return res.json({ ok: true });
}
