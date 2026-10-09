import { prisma } from "../prisma";
import { currentSeason } from "./saison.service";

/* ============================================================
   Alliances (2.0).

   Jusqu'à cinq compagnies. Ce que l'alliance change dans le jeu :
   - correspondance d'alliance : une gare que desservent aussi des alliés
     rapporte 3 % de plus par allié (jusqu'à +9 %) sur chaque trajet qui
     y part ou y arrive ;
   - pas de redevance de quai entre alliés dans les gares achetées ;
   - un classement des alliances, la somme des points de saison des membres ;
   - un tableau d'affichage, messages courts gardés sept jours.
   ============================================================ */

export const ALLIANCE_MAX = 5;
export const ALLIANCE_COST = 500;
export const ALLY_STEP = 0.03;
export const ALLY_MAX_ALLIES = 3;
export const MESSAGE_MAX = 280;
export const MESSAGE_DAYS = 7;
export const MESSAGE_COOLDOWN_MS = 15_000;

export const ALLIANCE_COLORS = ["#f59e0b", "#38bdf8", "#10b981", "#ef4444", "#a78bfa", "#f472b6", "#e2e8f0"];

/* Compagnie → alliance, pour la simulation et les redevances. Relu au plus
   toutes les trente secondes. */
let cache: { at: number; map: Map<string, string> } | null = null;
export async function allianceMap() {
  if (cache && Date.now() - cache.at < 30_000) return cache.map;
  const rows = (await prisma.allianceMember.findMany({ select: { allianceId: true, companyId: true } })) as { allianceId: string; companyId: string }[];
  cache = { at: Date.now(), map: new Map(rows.map((r) => [r.companyId, r.allianceId])) };
  return cache.map;
}
export function invalidateAlliances() {
  cache = null;
}

/* Les alliés d'une compagnie (sans elle-même). */
export function alliesOf(map: Map<string, string>, companyId: string) {
  const a = map.get(companyId);
  if (!a) return new Set<string>();
  const set = new Set<string>();
  for (const [c, al] of map) if (al === a && c !== companyId) set.add(c);
  return set;
}

/* Bonus de correspondance d'alliance d'un trajet : les alliés qui desservent
   (avec au moins une rame) l'une des deux gares du trajet. */
export function allyMultiplier(allies: Set<string>, stationCounts: Map<string, Map<string, number>>, dep: string, arr: string) {
  if (allies.size === 0) return 1;
  let n = 0;
  for (const ally of allies) {
    const counts = stationCounts.get(ally);
    if (counts && ((counts.get(dep) ?? 0) > 0 || (counts.get(arr) ?? 0) > 0)) n++;
  }
  return 1 + ALLY_STEP * Math.min(ALLY_MAX_ALLIES, n);
}

export async function allianceOfCompany(companyId: string) {
  const m = await prisma.allianceMember.findUnique({ where: { companyId } });
  return m ? prisma.alliance.findUnique({ where: { id: m.allianceId } }) : null;
}

/* Classement des alliances : somme des points de saison des membres. */
export async function allianceRanking() {
  const season = await currentSeason();
  const members = (await prisma.allianceMember.findMany({ select: { allianceId: true, companyId: true } })) as { allianceId: string; companyId: string }[];
  const alliances = (await prisma.alliance.findMany({ select: { id: true, name: true, color: true } })) as { id: string; name: string; color: string }[];
  const points = new Map<string, number>();
  if (season && members.length) {
    const entries = (await prisma.seasonEntry.findMany({
      where: { seasonId: season.id, companyId: { in: members.map((m) => m.companyId) } },
      select: { companyId: true, points: true },
    })) as { companyId: string; points: number }[];
    const byCompany = new Map(entries.map((e) => [e.companyId, e.points]));
    for (const m of members) points.set(m.allianceId, (points.get(m.allianceId) ?? 0) + (byCompany.get(m.companyId) ?? 0));
  }
  const count = new Map<string, number>();
  for (const m of members) count.set(m.allianceId, (count.get(m.allianceId) ?? 0) + 1);
  return alliances
    .map((a) => ({ id: a.id, name: a.name, color: a.color, members: count.get(a.id) ?? 0, points: points.get(a.id) ?? 0 }))
    .filter((a) => a.members > 0)
    .sort((x, y) => y.points - x.points)
    .map((a, i) => ({ ...a, rank: i + 1 }));
}

export async function pruneMessages() {
  await prisma.allianceMessage.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - MESSAGE_DAYS * 86_400_000) } } });
}

/* Un nom d'alliance : lettres, chiffres, espaces et ponctuation simple. */
export function cleanName(raw: unknown) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (s.length < 3 || s.length > 32) return null;
  if (!/^[\p{L}\p{N} '’\-&.]+$/u.test(s)) return null;
  return s;
}
