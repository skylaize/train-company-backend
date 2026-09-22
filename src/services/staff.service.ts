import { prisma } from "../prisma";

/* ============================================================
   Personnel.

   Ce que ça corrige : trois postes fixes, un employé chacun, un effet
   identique pour 2 rames ou 14. C'était une case à cocher — on embauchait les
   trois une fois, puis plus jamais rien à décider.

   Deux idées, qui se complètent :

   1. L'EXPÉRIENCE. Chaque employé est une personne qui progresse avec le
      temps de service. En montant de niveau, il réclame une augmentation :
      l'accorder le rend meilleur et plus cher, la refuser le laisse à son
      niveau. Garder un vétéran devient un choix, pas un automatisme.

   2. LA COUVERTURE. Un mécanicien ou un chef de dépôt ne s'occupe que d'un
      nombre limité de rames. Au-delà, les rames non couvertes s'usent et se
      réparent au tarif normal. L'équipe doit donc grandir avec la flotte, et
      c'est une décision qui revient à chaque agrandissement du dépôt.

   Le directeur commercial reste unique : un seul directeur par compagnie,
   sinon son bonus se multiplierait sans fin.
   ============================================================ */

export const TICKS_PER_HOUR = 120;
// usure d'une rame en service à chaque tick, avant l'effet des mécaniciens
export const WEAR_PER_TICK = 2;

/* Seuils d'expérience, en ticks de service (un tick = 30 s).
   Niveau 2 après 6 h, 3 après 24 h, 4 après 3 jours, 5 après une semaine. */
export const LEVEL_THRESHOLDS = [0, 6 * 120, 24 * 120, 72 * 120, 168 * 120];
export const MAX_LEVEL = 5;

export function levelFromXp(xp: number) {
  let level = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_THRESHOLDS[i]) level = i + 1;
  }
  return Math.min(MAX_LEVEL, level);
}

export interface RoleDef {
  label: string;
  baseSalary: number; // par tick, au niveau 1
  minGradeId: number;
  unique: boolean;
  effect: (level: number) => string;
}

export const ROLES: Record<string, RoleDef> = {
  MECANICIEN: {
    label: "Mécanicien",
    baseSalary: 3,
    minGradeId: 0,
    unique: false,
    effect: (l) => `Réduit de ${Math.round(mechanicReduction(l) * 100)} % l'usure de ${mechanicCoverage(l)} rames`,
  },
  CHEF_DEPOT: {
    label: "Chef de dépôt",
    baseSalary: 4,
    minGradeId: 0,
    unique: false,
    effect: (l) => `Réduit de ${Math.round(chefReduction(l) * 100)} % le coût des réparations de ${chefCoverage(l)} rames`,
  },
  DIRECTEUR_COMMERCIAL: {
    label: "Directeur commercial",
    baseSalary: 6,
    minGradeId: 2,
    unique: true,
    effect: (l) => `Augmente de ${Math.round(directorBonus(l) * 100)} % toutes vos recettes`,
  },
};

/* Salaire : +25 % par niveau accordé. Un vétéran de niveau 5 coûte le double
   d'un débutant — c'est ce qui rend la question de l'augmentation réelle. */
export function salaryFor(role: string, level: number) {
  const base = ROLES[role]?.baseSalary ?? 0;
  return Math.round(base * (1 + 0.25 * (level - 1)));
}

// niveau 1 : exactement l'effet de l'ancien système, pour ne pas surprendre
export function mechanicReduction(level: number) {
  return 0.5 + 0.03 * (level - 1); // 50 % → 62 %
}
export function mechanicCoverage(level: number) {
  return 3 + level; // 4 → 8 rames
}
export function chefReduction(level: number) {
  return 0.5 + 0.03 * (level - 1); // 50 % → 62 %
}
export function chefCoverage(level: number) {
  return 5 + level; // 6 → 10 rames
}
export function directorBonus(level: number) {
  return 0.15 + 0.0125 * (level - 1); // 15 % → 20 %
}

type StaffRow = { companyId: string; role: string; level: number };

/* Effet d'une équipe sur une flotte donnée. Les employés les plus expérimentés
   couvrent en premier : on remplit la flotte rame par rame avec la meilleure
   réduction disponible, puis on fait la moyenne sur toute la flotte. */
function teamReduction(
  members: StaffRow[],
  trainCount: number,
  reduction: (l: number) => number,
  coverage: (l: number) => number
) {
  if (trainCount <= 0 || members.length === 0) return 0;
  const sorted = [...members].sort((a, b) => b.level - a.level);
  let remaining = trainCount;
  let total = 0;
  for (const m of sorted) {
    if (remaining <= 0) break;
    const covered = Math.min(remaining, coverage(m.level));
    total += covered * reduction(m.level);
    remaining -= covered;
  }
  return total / trainCount;
}

export interface CompanyStaffEffects {
  wearMultiplier: number; // appliqué à l'usure de chaque rame
  repairMultiplier: number; // appliqué au coût d'un point de réparation
  revenueMultiplier: number; // appliqué aux recettes voyageurs et fret
}

const NEUTRAL: CompanyStaffEffects = { wearMultiplier: 1, repairMultiplier: 1, revenueMultiplier: 1 };

/* Calcul pour toutes les compagnies en deux requêtes : le tick de simulation
   en a besoin à chaque tour, et interroger la base rame par rame serait
   absurde. */
export async function staffEffectsByCompany(): Promise<Map<string, CompanyStaffEffects>> {
  const [staff, trainCounts] = await Promise.all([
    prisma.staff.findMany({ select: { companyId: true, role: true, level: true } }),
    prisma.train.groupBy({ by: ["companyId"], _count: { _all: true } }),
  ]);

  const countBy = new Map<string, number>(
    (trainCounts as { companyId: string; _count: { _all: number } }[]).map((t) => [t.companyId, t._count._all])
  );

  const byCompany = new Map<string, StaffRow[]>();
  for (const s of staff as StaffRow[]) {
    const list = byCompany.get(s.companyId) ?? [];
    list.push(s);
    byCompany.set(s.companyId, list);
  }

  const out = new Map<string, CompanyStaffEffects>();
  for (const [companyId, members] of byCompany) {
    out.set(companyId, effectsFor(members, countBy.get(companyId) ?? 0));
  }
  return out;
}

export function effectsFor(members: StaffRow[], trainCount: number): CompanyStaffEffects {
  const mechanics = members.filter((m) => m.role === "MECANICIEN");
  const chefs = members.filter((m) => m.role === "CHEF_DEPOT");
  const director = members.find((m) => m.role === "DIRECTEUR_COMMERCIAL");

  return {
    wearMultiplier: 1 - teamReduction(mechanics, trainCount, mechanicReduction, mechanicCoverage),
    repairMultiplier: 1 - teamReduction(chefs, trainCount, chefReduction, chefCoverage),
    revenueMultiplier: director ? 1 + directorBonus(director.level) : 1,
  };
}

export async function staffEffectsFor(companyId: string): Promise<CompanyStaffEffects> {
  const [members, trainCount] = await Promise.all([
    prisma.staff.findMany({ where: { companyId }, select: { companyId: true, role: true, level: true } }),
    prisma.train.count({ where: { companyId } }),
  ]);
  if ((members as StaffRow[]).length === 0) return NEUTRAL;
  return effectsFor(members as StaffRow[], trainCount);
}

export const REPAIR_COST_PER_POINT = 2;

/* Nombre de rames que chaque employé couvre réellement, dans l'ordre où
   teamReduction les attribue (les plus expérimentés d'abord). Sert à dire au
   joueur ce que rapporte CHAQUE employé, pas seulement l'équipe. */
export function coverageAllocation(
  members: { id: string; role: string; level: number }[],
  trainCount: number
): Map<string, number> {
  const out = new Map<string, number>();
  for (const role of ["MECANICIEN", "CHEF_DEPOT"]) {
    const cov = role === "MECANICIEN" ? mechanicCoverage : chefCoverage;
    let remaining = trainCount;
    [...members.filter((m) => m.role === role)]
      .sort((a, b) => b.level - a.level)
      .forEach((m) => {
        const n = Math.max(0, Math.min(remaining, cov(m.level)));
        out.set(m.id, n);
        remaining -= n;
      });
  }
  return out;
}

/* Économie horaire estimée d'un employé, rames en service en continu.
   - mécanicien : l'usure évitée, au prix actuel du point de réparation ;
   - chef de dépôt : la remise sur les réparations que ses rames subissent
     encore, mécaniciens compris ;
   - directeur : sa part des recettes, estimée sur les dernières 24 h. */
export function estimatedSavingsPerHour(
  member: { role: string; level: number },
  covered: number,
  effects: CompanyStaffEffects,
  revenuePerHour: number
) {
  if (member.role === "MECANICIEN") {
    return covered * WEAR_PER_TICK * mechanicReduction(member.level) * repairCostPerPoint(effects) * TICKS_PER_HOUR;
  }
  if (member.role === "CHEF_DEPOT") {
    const pointsPerHour = WEAR_PER_TICK * effects.wearMultiplier * TICKS_PER_HOUR;
    return covered * pointsPerHour * REPAIR_COST_PER_POINT * chefReduction(member.level);
  }
  if (member.role === "DIRECTEUR_COMMERCIAL") {
    const b = directorBonus(member.level);
    return (revenuePerHour * b) / (1 + b);
  }
  return 0;
}

/* Coût d'un point de réparation pour une compagnie. Le même calcul sert à la
   réparation manuelle, à la réparation automatique et à l'affichage du prix :
   s'ils divergeaient, le bouton annoncerait un prix et en facturerait un autre. */
export function repairCostPerPoint(effects: CompanyStaffEffects) {
  return REPAIR_COST_PER_POINT * effects.repairMultiplier;
}

/* Expérience : un point par tick de service, pour tous les employés. Le
   passage de niveau n'est pas automatique — il ouvre une demande
   d'augmentation, que le joueur accorde ou refuse. */
export async function runStaffExperience() {
  await prisma.staff.updateMany({ data: { xp: { increment: 1 } } });

  const candidates = await prisma.staff.findMany({
    where: { raiseRequested: false, level: { lt: MAX_LEVEL } },
    select: { id: true, xp: true, level: true, refusedAtXp: true },
  });

  for (const s of candidates as { id: string; xp: number; level: number; refusedAtXp: number }[]) {
    const reached = levelFromXp(s.xp);
    if (reached <= s.level) continue;
    /* Après un refus, l'employé ne redemande pas au tick suivant : il attend
       d'avoir accumulé l'équivalent d'un niveau d'expérience de plus. */
    if (s.refusedAtXp > 0 && s.xp < s.refusedAtXp + LEVEL_THRESHOLDS[1]) continue;
    await prisma.staff.update({ where: { id: s.id }, data: { raiseRequested: true } });
  }
}

const FIRST = ["Jeanne", "Louis", "Marcel", "Odette", "Henri", "Simone", "Gaston", "Lucienne", "René", "Paulette", "André", "Germaine", "Émile", "Yvonne", "Raymond", "Suzanne", "Fernand", "Madeleine", "Lucien", "Marthe"];
const LAST = ["Morel", "Garnier", "Lefèvre", "Roux", "Fontaine", "Chevalier", "Mercier", "Blanchard", "Gauthier", "Perrin", "Dubois", "Lambert", "Bonnet", "Faure", "Rousseau", "Girard", "Vidal", "Caron", "Masson", "Renaud"];

export function randomStaffName() {
  const f = FIRST[Math.floor(Math.random() * FIRST.length)];
  const l = LAST[Math.floor(Math.random() * LAST.length)];
  return `${f} ${l}`;
}
