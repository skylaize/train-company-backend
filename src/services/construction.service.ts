import { prisma } from "../prisma";
import { depotExpansionCost } from "./upkeep.service";
import { sendToCompany } from "./push.service";

/* ============================================================
   Chantiers.

   Le problème que ça corrige : l'argent se convertissait instantanément en
   progression. Une compagnie qui avait accumulé 30 000 pièces achetait dix
   places de dépôt en dix clics et se retrouvait devant exactement le même jeu,
   en plus grand, sans avoir rien décidé.

   Un chantier prend du temps réel et il n'y en a qu'un à la fois. La
   trésorerie ne suffit donc plus : il faut aussi choisir l'ORDRE dans lequel
   on construit, et vivre avec ce choix pendant quelques heures.

   Règle importante : les abonnés ne construisent pas plus vite. Accélérer les
   chantiers serait vendre du rendement ; on s'y est refusé partout ailleurs,
   il n'y a pas de raison de céder ici.
   ============================================================ */

export const WAREHOUSE_BUILD_COST = 1_200;
export const WAREHOUSE_BASE_CAPACITY = 20;
export const WAREHOUSE_CAPACITY_STEP = 15;

export const WAREHOUSE_EXPANSION_BASE = 900;
export const WAREHOUSE_EXPANSION_GROWTH = 1.65;

/* Nombre de marchandises différentes stockables en même temps. C'est là que se
   place l'avantage des abonnés : de la VARIÉTÉ, pas du volume. Un abonné peut
   suivre cinq cours à la fois, il ne peut pas stocker une unité de plus. */
export const STOCK_TYPES_FREE = 2;
export const STOCK_TYPES_PREMIUM = 5;

export function warehouseExpansionCost(level: number) {
  return Math.round(WAREHOUSE_EXPANSION_BASE * Math.pow(WAREHOUSE_EXPANSION_GROWTH, Math.max(0, level - 1)));
}

/* Durées, en heures. Volontairement courtes au début — un nouveau joueur ne
   doit pas attendre sa première place de dépôt une demi-journée — et longues
   ensuite, là où le jeu manquait de frein. */
export function depotBuildHours(currentSlots: number) {
  return Math.min(6, 0.5 * Math.pow(1.35, Math.max(0, currentSlots - 2)));
}

export function warehouseBuildHours() {
  return 2;
}

export function warehouseExpansionHours(level: number) {
  return Math.min(8, 2 + 0.75 * Math.max(0, level - 1));
}

export type ConstructionKind = "DEPOT" | "ENTREPOT" | "ENTREPOT_AGRANDISSEMENT";

/* Ce qu'un chantier donné coûterait et durerait, pour l'afficher avant la
   commande. Le joueur doit voir le temps AVANT de payer, sinon le chantier est
   une mauvaise surprise et non une décision. */
export async function quoteFor(companyId: string, kind: ConstructionKind) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { maxTrains: true, isPremium: true },
  });
  if (!company) return null;

  const warehouse = await prisma.warehouse.findUnique({ where: { companyId } });

  if (kind === "DEPOT") {
    return {
      kind,
      label: `Agrandissement du dépôt (${company.maxTrains + 1} places)`,
      cost: depotExpansionCost(company.maxTrains, company.isPremium),
      hours: depotBuildHours(company.maxTrains),
      available: true,
      reason: null as string | null,
    };
  }

  if (kind === "ENTREPOT") {
    return {
      kind,
      label: "Construction de l'entrepôt",
      cost: WAREHOUSE_BUILD_COST,
      hours: warehouseBuildHours(),
      available: !warehouse,
      reason: warehouse ? "Votre compagnie possède déjà un entrepôt" : null,
    };
  }

  return {
    kind,
    label: warehouse
      ? `Agrandissement de l'entrepôt (${warehouse.capacity + WAREHOUSE_CAPACITY_STEP} unités)`
      : "Agrandissement de l'entrepôt",
    cost: warehouse ? warehouseExpansionCost(warehouse.level) : WAREHOUSE_EXPANSION_BASE,
    hours: warehouse ? warehouseExpansionHours(warehouse.level) : warehouseExpansionHours(1),
    available: Boolean(warehouse),
    reason: warehouse ? null : "Construisez d'abord un entrepôt",
  };
}

export async function activeConstruction(companyId: string) {
  return prisma.construction.findFirst({
    where: { companyId, done: false },
    orderBy: { startedAt: "desc" },
  });
}

/* Livraison des chantiers arrivés à terme. Appelée par le tick de simulation :
   le chantier se termine que le joueur soit connecté ou non, sinon fermer
   l'onglet reviendrait à mettre le temps en pause. */
export async function completeConstructions() {
  const due = await prisma.construction.findMany({
    where: { done: false, endsAt: { lte: new Date() } },
  });

  for (const c of due as { id: string; kind: string; companyId: string; label: string }[]) {
    /* Le chantier se termine souvent quand le joueur n'est pas là — c'est même
       l'usage normal, puisqu'il dure des heures. La notification est donc le
       seul moyen qu'il l'apprenne au bon moment. Elle n'est pas réservée aux
       abonnés : prévenir de la fin d'un chantier n'est pas un avantage, c'est
       le minimum pour que l'attente reste jouable. */
    await sendToCompany(c.companyId, {
      title: "Chantier terminé",
      body: `${c.label} — votre compagnie peut lancer le chantier suivant.`,
      url: "/dashboard",
      tag: "chantier",
    });

    if (c.kind === "DEPOT") {
      await prisma.$transaction([
        prisma.company.update({ where: { id: c.companyId }, data: { maxTrains: { increment: 1 } } }),
        prisma.construction.update({ where: { id: c.id }, data: { done: true } }),
      ]);
    } else if (c.kind === "ENTREPOT") {
      const existing = await prisma.warehouse.findUnique({ where: { companyId: c.companyId } });
      await prisma.$transaction([
        ...(existing
          ? []
          : [
              prisma.warehouse.create({
                data: { companyId: c.companyId, capacity: WAREHOUSE_BASE_CAPACITY, level: 1 },
              }),
            ]),
        prisma.construction.update({ where: { id: c.id }, data: { done: true } }),
      ]);
    } else {
      const existing = await prisma.warehouse.findUnique({ where: { companyId: c.companyId } });
      await prisma.$transaction([
        ...(existing
          ? [
              prisma.warehouse.update({
                where: { companyId: c.companyId },
                data: {
                  capacity: { increment: WAREHOUSE_CAPACITY_STEP },
                  level: { increment: 1 },
                },
              }),
            ]
          : []),
        prisma.construction.update({ where: { id: c.id }, data: { done: true } }),
      ]);
    }
  }
}
