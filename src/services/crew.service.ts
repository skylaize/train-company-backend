import { prisma } from "../prisma";

/* ============================================================
   Les équipages (2.0).

   Jusqu'ici, le personnel agissait sur toute la flotte à la fois. Le
   contrôleur et le conducteur, eux, montent à bord d'UNE rame : c'est
   au joueur de décider laquelle en profite — la ligne la plus chargée,
   la rame la plus fragile, le train de luxe.

   - Le contrôleur fait payer ceux qui voyageaient sans billet (+4 % de
     recette au niveau 1, +1 % par niveau) et soigne l'accueil : chaque
     rame de ligne qui en a un rehausse la réputation de la compagnie
     (jusqu'à +6 points quand toute la flotte en ligne est contrôlée).
   - Le conducteur expérimenté conduit en douceur et voit venir le danger :
     moins de retards (−40 %), deux fois moins d'incidents sur la voie et
     de casse par négligence, et une usure réduite (−5 %, −1 % par niveau).

   Un employé non affecté est payé mais n'apporte rien.
   ============================================================ */

export const CREW_ROLES = ["CONTROLEUR", "CONDUCTEUR"] as const;
export type CrewRole = (typeof CREW_ROLES)[number];

export function controllerBonus(level?: number) {
  if (!level) return 1;
  return 1.04 + 0.01 * (level - 1);
}

export function driverEffects(level?: number) {
  if (!level) return { delay: 1, incident: 1, wear: 1 };
  return { delay: 0.6, incident: 0.5, wear: 1 - (0.05 + 0.01 * (level - 1)) };
}

export const CONTROLLER_REPUTATION_MAX = 6;

export async function crewByTrain(): Promise<Map<string, Partial<Record<CrewRole, number>>>> {
  const rows = (await prisma.staff.findMany({
    where: { trainId: { not: null }, role: { in: [...CREW_ROLES] } },
    select: { trainId: true, role: true, level: true },
  })) as { trainId: string; role: CrewRole; level: number }[];
  const out = new Map<string, Partial<Record<CrewRole, number>>>();
  for (const r of rows) {
    const c = out.get(r.trainId) ?? {};
    c[r.role] = Math.max(c[r.role] ?? 0, r.level);
    out.set(r.trainId, c);
  }
  return out;
}

/* Part des rames de ligne qui ont un contrôleur à bord, en points de réputation. */
export async function controllerReputation(companyId: string) {
  const [lineTrains, controlled] = await Promise.all([
    prisma.train.count({ where: { companyId, lineId: { not: null } } }),
    prisma.staff.count({ where: { companyId, role: "CONTROLEUR", trainId: { not: null } } }),
  ]);
  if (lineTrains === 0 || controlled === 0) return 0;
  return Math.round(CONTROLLER_REPUTATION_MAX * Math.min(1, controlled / lineTrains));
}
