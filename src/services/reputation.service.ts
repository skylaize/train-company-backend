import { prisma } from "../prisma";

// Réputation = pourcentage de trajets voyageurs réussis sans incident (retard/panne),
// sur l'ensemble des trajets + incidents enregistrés. 100 par défaut si aucun historique.
export async function computeReputation(companyId: string): Promise<number> {
  const [goodTrips, incidents, company] = await Promise.all([
    prisma.transaction.count({ where: { companyId, type: "REVENU_LIGNE" } }),
    prisma.incident.count({ where: { train: { companyId } } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { reputationAdjust: true } }),
  ]);

  const total = goodTrips + incidents;
  const base = total === 0 ? 100 : Math.round((goodTrips / total) * 100);
  // 1.6 : les décisions du directeur font gagner ou perdre quelques points
  const adjust = (company as { reputationAdjust?: number } | null)?.reputationAdjust ?? 0;
  return Math.max(0, Math.min(100, base + adjust));
}
