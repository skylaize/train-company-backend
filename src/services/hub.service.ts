import { prisma } from "../prisma";

/* ============================================================
   Correspondances (1.5).

   Une gare où arrivent plusieurs lignes d'une même compagnie devient une
   correspondance : les voyageurs peuvent y changer de train sans changer de
   compagnie, et chaque trajet qui part ou arrive là rapporte un peu plus.

   +4 % par destination au-delà de la première (lignes où roule une rame),
   plafonné à +12 % par gare. Une ligne
   entre deux correspondances pleines rapporte donc jusqu'à +24 %. C'est ce
   qui rend le dessin du réseau intéressant : dix lignes éparpillées
   rapportent moins que dix lignes qui se croisent. Deux lignes vers la même
   gare ne comptent qu'une fois.
   ============================================================ */

export const HUB_STEP = 0.04;
export const HUB_CAP = 0.12;

export function hubBonus(linesAtStation: number) {
  return Math.min(HUB_CAP, HUB_STEP * Math.max(0, linesAtStation - 1));
}

type LineEnds = { companyId: string; departureStation: string; arrivalStation: string; trains?: number };

/* Pour chaque compagnie : nombre de gares DISTINCTES reliées à chaque gare,
   par des lignes où roule au moins une rame. Compter les lignes brutes
   laissait gonfler une correspondance avec des doublons ou des lignes vides,
   qui ne coûtent rien : une correspondance, c'est des trains vers d'autres
   destinations. */
export function stationCounts(lines: LineEnds[]) {
  const links = new Map<string, Map<string, Set<string>>>();
  for (const l of lines) {
    if (l.trains === 0 || l.departureStation === l.arrivalStation) continue;
    let m = links.get(l.companyId);
    if (!m) { m = new Map(); links.set(l.companyId, m); }
    for (const [s, other] of [[l.departureStation, l.arrivalStation], [l.arrivalStation, l.departureStation]]) {
      let set = m.get(s);
      if (!set) { set = new Set(); m.set(s, set); }
      set.add(other);
    }
  }
  const byCompany = new Map<string, Map<string, number>>();
  for (const [companyId, m] of links) {
    byCompany.set(companyId, new Map([...m.entries()].map(([s, set]) => [s, set.size])));
  }
  return byCompany;
}

/* Lignes avec leur nombre de rames, au format attendu par stationCounts. */
export function withTrainCount<T extends { _count?: { trains: number } }>(l: T) {
  return { ...l, trains: l._count?.trains ?? 0 };
}

export async function allStationCounts() {
  const lines = (await prisma.line.findMany({
    select: { companyId: true, departureStation: true, arrivalStation: true, _count: { select: { trains: true } } },
  })) as (LineEnds & { _count: { trains: number } })[];
  return stationCounts(lines.map(withTrainCount));
}

/* Multiplicateur de recette d'une ligne : ses deux bouts, chacun selon sa correspondance. */
export function hubMultiplier(counts: Map<string, number> | undefined, dep: string, arr: string) {
  if (!counts) return 1;
  return 1 + hubBonus(counts.get(dep) ?? 0) + hubBonus(counts.get(arr) ?? 0);
}

/* Les correspondances d'une compagnie, de la plus fournie à la moins fournie. */
export function hubsOf(counts: Map<string, number> | undefined) {
  if (!counts) return [];
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([station, lines]) => ({ station, lines, bonus: Math.round(hubBonus(lines) * 100) }))
    .sort((a, b) => b.lines - a.lines || a.station.localeCompare(b.station));
}
