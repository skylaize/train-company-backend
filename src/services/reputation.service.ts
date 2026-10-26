import { prisma } from "../prisma";
import { lifetimeStats } from "./lifetime.service";
import { controllerReputation, CONTROLLER_REPUTATION_MAX } from "./crew.service";

/* ============================================================
   Réputation = pourcentage de trajets voyageurs réussis sans incident
   (retard/panne), sur l'ensemble des trajets + incidents enregistrés. 100 par
   défaut si aucun historique. S'y ajoutent les décisions du directeur (1.6)
   et les contrôleurs à bord (2.0).

   2.4 : la partie chère, ce sont les deux comptages (trajets réussis et
   incidents) sur des tables de plusieurs millions de lignes. La simulation
   les refaisait à CHAQUE arrivée de train, et chaque tableau de bord à chaque
   affichage. Or un trajet de plus sur des milliers ne bouge pas le
   pourcentage : les comptages de toutes les compagnies sont faits en deux
   requêtes, gardés cinq minutes et rafraîchis en arrière-plan. Les bonus
   (décisions, contrôleurs) restent lus en direct : une décision qui donne
   des points se voit tout de suite.
   ============================================================ */

type Counts = { good: number; incidents: number };

/* 2.4 : les comptages viennent des compteurs « depuis toujours » de
   lifetime.service, complétés par morceaux au lieu de relire les tables. */
async function allCounts(): Promise<Map<string, Counts>> {
  const life = await lifetimeStats();
  const map = new Map<string, Counts>();
  for (const [id, s] of life) map.set(id, { good: s.trips, incidents: s.incidents });
  return map;
}

function baseOf(c: Counts | undefined) {
  if (!c) return 100;
  const total = c.good + c.incidents;
  return total === 0 ? 100 : Math.round((c.good / total) * 100);
}

export async function computeReputation(companyId: string): Promise<number> {
  const map = await allCounts().catch(() => null);
  let c = map?.get(companyId);
  if (!c && !map) {
    // cache indisponible : l'ancien calcul direct
    const [good, incidents] = await Promise.all([
      prisma.transaction.count({ where: { companyId, type: "REVENU_LIGNE" } }),
      prisma.incident.count({ where: { train: { companyId } } }),
    ]);
    c = { good, incidents };
  }
  // compagnie absente du cache : aucun trajet ni incident il y a cinq minutes, donc 100
  const base = baseOf(c);
  const [company, crew] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { reputationAdjust: true } }),
    controllerReputation(companyId).catch(() => 0),
  ]);
  // 1.6 : les décisions du directeur font gagner ou perdre quelques points
  const adjust = (company as { reputationAdjust?: number } | null)?.reputationAdjust ?? 0;
  return Math.max(0, Math.min(100, base + adjust + crew));
}

/* Réputation de toutes les compagnies, pour la simulation : comptages en
   cache, bonus relus en trois petites requêtes pour tout le monde. */
export async function reputationMap(): Promise<Map<string, number>> {
  const [map, companies, lineTrains, controlled] = await Promise.all([
    allCounts(),
    prisma.company.findMany({ select: { id: true, reputationAdjust: true } }),
    prisma.train.groupBy({ by: ["companyId"], where: { lineId: { not: null } }, _count: { _all: true } }),
    prisma.staff.groupBy({ by: ["companyId"], where: { role: "CONTROLEUR", trainId: { not: null } }, _count: { _all: true } }),
  ]);
  const lineBy = new Map((lineTrains as { companyId: string; _count: { _all: number } }[]).map((r) => [r.companyId, r._count._all]));
  const ctrlBy = new Map((controlled as { companyId: string; _count: { _all: number } }[]).map((r) => [r.companyId, r._count._all]));
  const out = new Map<string, number>();
  for (const c of companies as { id: string; reputationAdjust: number }[]) {
    const lt = lineBy.get(c.id) ?? 0;
    const ct = ctrlBy.get(c.id) ?? 0;
    const crew = lt === 0 || ct === 0 ? 0 : Math.round(CONTROLLER_REPUTATION_MAX * Math.min(1, ct / lt));
    out.set(c.id, Math.max(0, Math.min(100, baseOf(map.get(c.id)) + (c.reputationAdjust ?? 0) + crew)));
  }
  return out;
}
