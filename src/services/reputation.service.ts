import { prisma } from "../prisma";

// Réputation = pourcentage de trajets voyageurs réussis sans incident (retard/panne),
// sur l'ensemble des trajets + incidents enregistrés. 100 par défaut si aucun historique.
export async function computeReputation(companyId: string): Promise<number> {
  const [goodTrips, incidents] = await Promise.all([
    prisma.transaction.count({ where: { companyId, type: "REVENU_LIGNE" } }),
    prisma.incident.count({ where: { train: { companyId } } }),
  ]);

  const total = goodTrips + incidents;
  if (total === 0) return 100;

  return Math.round((goodTrips / total) * 100);
}
