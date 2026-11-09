import { prisma } from "../prisma";
import { REGIONS, REGION_OF } from "./regions.service";

/* ============================================================
   2.7 : l'éruption solaire.

   L'éruption grille les sous-stations une région après l'autre :
   - chaque région passe d'abord en « tension réduite » (les rames
     électriques parties depuis roulent à moitié de leur vitesse),
   - puis en « coupure » : les rames électriques finissent le trajet en
     cours et restent à quai ;
   - la région suivante est touchée stepMinutes plus tard. En une journée
     environ, toute la France métropolitaine est dans le noir. La Corse et
     l'étranger ne sont pas touchés.

   Le diesel et la vapeur roulent. La réparation est commune : chaque
   conteneur de matériel électrique livré donne un point, que le joueur
   dépense dans la sous-station de son choix. Quand une sous-station a tous
   ses points, sa région retrouve le courant. Une sous-station que personne
   ne répare se répare toute seule autoRepairDays après sa coupure.

   Tout se lit en mémoire (relu toutes les 30 s) : la simulation demande
   l'état d'un itinéraire à chaque rame sans requête de plus.
   ============================================================ */

export type EruptionConfig = {
  startsAt: string; // début de l'éruption (en même temps que la saison)
  order: string[]; // l'ordre dans lequel les régions tombent
  stepMinutes: number; // écart entre deux régions
  reducedMinutes: number; // durée de la tension réduite avant la coupure
  autoRepairDays: number; // filet de sécurité
  containersOpen: number; // conteneurs de matériel électrique proposés en même temps
  containerChance: number; // chance par tour de 30 s d'en ajouter un, s'il en manque
};

export type RegionStatus = "normal" | "alerte" | "reduite" | "coupee" | "reparee";

// Prix de chaque sous-station, en points : selon le poids de la région sur le réseau.
// Réglables depuis l'admin une fois l'éruption lancée.
// 2.7.1 : ×2,5, les joueurs les réparaient trop vite.
export const DEFAULT_COSTS: Record<string, number> = {
  idf: 400,
  ara: 325,
  "grand-est": 275,
  "nouvelle-aquitaine": 275,
  occitanie: 250,
  paca: 250,
  hdf: 225,
  pdl: 200,
  normandie: 200,
  bretagne: 175,
  cvl: 175,
  bfc: 175,
};

export const ERUPTION_REGIONS = REGIONS.filter((r) => !r.dlc && r.id !== "etranger");
export const ICON_SHARE = 0.1; // 10 % d'une sous-station : l'icône électrique
export const ERUPTION_EMBLEM = "pylone";
export const ELECTRIC_CARGO = "Matériel électrique";

const KEY = "eruption";
const REFRESH_MS = 30_000;

type Station = { region: string; cost: number; points: number; repairedAt: Date | null; auto: boolean };
let cfg: EruptionConfig | null = null;
let stations = new Map<string, Station>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

async function reload() {
  try {
    const row = await prisma.gameSetting.findUnique({ where: { key: KEY } });
    cfg = (row?.value as EruptionConfig | undefined) ?? null;
    if (cfg) {
      const rows = (await prisma.subStation.findMany()) as Station[];
      stations = new Map(rows.map((r) => [r.region, r]));
    } else stations = new Map();
    loadedAt = Date.now();
  } catch (err) {
    console.error("[éruption] lecture :", (err as Error).message);
    loadedAt = Date.now() - REFRESH_MS + 10_000;
  } finally {
    loading = null;
  }
}

function fresh() {
  if (Date.now() - loadedAt > REFRESH_MS && !loading) loading = reload();
}

export async function loadEruption() {
  if (!loading) loading = reload();
  await loading;
  return cfg;
}

export function eruptionConfig() {
  fresh();
  return cfg;
}

/* Quand la région est touchée (début de la tension réduite) et coupée. */
export function regionTimes(region: string, c = cfg) {
  if (!c) return null;
  const i = c.order.indexOf(region);
  if (i < 0) return null;
  const alertAt = Date.parse(c.startsAt) + i * c.stepMinutes * 60_000;
  const cutAt = alertAt + c.reducedMinutes * 60_000;
  return { alertAt, cutAt, autoAt: cutAt + c.autoRepairDays * 86_400_000 };
}

export function regionStatus(region: string, now = Date.now()): RegionStatus {
  fresh();
  if (!cfg || now < Date.parse(cfg.startsAt)) return "normal";
  const t = regionTimes(region);
  if (!t) return "normal";
  const st = stations.get(region);
  if (st?.repairedAt || now >= t.autoAt) return "reparee";
  if (now < t.alertAt) return "alerte";
  return now < t.cutAt ? "reduite" : "coupee";
}

/* L'éruption est en cours : commencée, et au moins une région pas encore réparée. */
export function eruptionActive(now = Date.now()) {
  fresh();
  if (!cfg || now < Date.parse(cfg.startsAt)) return false;
  return cfg.order.some((r) => regionStatus(r, now) !== "reparee");
}

/* L'état d'un itinéraire pour une rame électrique : la pire région traversée.
   since = début de la tension réduite de cette région : seules les rames
   parties depuis sont ralenties (pas de retour en arrière de la progression). */
export function routeEruption(route: string[], now = Date.now()): { status: "reduite" | "coupee"; since: number } | null {
  if (!cfg) return null;
  let worst: { status: "reduite" | "coupee"; since: number } | null = null;
  for (const region of new Set(route.map((st) => REGION_OF[st]).filter(Boolean))) {
    const s = regionStatus(region, now);
    if (s !== "reduite" && s !== "coupee") continue;
    const since = regionTimes(region)!.alertAt;
    if (!worst || (s === "coupee" && worst.status === "reduite")) worst = { status: s, since };
  }
  return worst;
}

/* Lance (ou relance) l'éruption : sous-stations remises à zéro, ordre tiré au sort. */
export async function launchEruption(startsAt: Date, opts: Partial<EruptionConfig> = {}) {
  const order = [...ERUPTION_REGIONS.map((r) => r.id)].sort(() => Math.random() - 0.5);
  const c: EruptionConfig = {
    startsAt: startsAt.toISOString(),
    order,
    // 2.7.1 : une région toutes les 40 min (au lieu de 2 h) : trop calme, d'après les joueurs
    stepMinutes: 40,
    reducedMinutes: 40,
    autoRepairDays: 12,
    containersOpen: 6,
    containerChance: 0.35,
    ...opts,
  };
  await prisma.$transaction([
    prisma.subStationGift.deleteMany({}),
    prisma.subStation.deleteMany({}),
    prisma.subStation.createMany({ data: ERUPTION_REGIONS.map((r) => ({ region: r.id, cost: DEFAULT_COSTS[r.id] ?? 80 })) }),
    prisma.gameSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: c as object }, update: { value: c as object } }),
  ]);
  await loadEruption();
  return c;
}

export async function updateEruption(patch: Partial<EruptionConfig>) {
  const c = await loadEruption();
  if (!c) return null;
  const next = { ...c, ...patch };
  await prisma.gameSetting.update({ where: { key: KEY }, data: { value: next as object } });
  await loadEruption();
  return next;
}

export async function stopEruption() {
  await prisma.gameSetting.deleteMany({ where: { key: KEY } });
  await loadEruption();
}

/* Filet de sécurité : les sous-stations oubliées se réparent toutes seules.
   Appelé une fois par heure par la simulation. */
export async function autoRepair(now = Date.now()) {
  if (!(await loadEruption())) return [];
  const done: string[] = [];
  for (const region of cfg!.order) {
    const t = regionTimes(region)!;
    const st = stations.get(region);
    if (st && !st.repairedAt && now >= t.autoAt) {
      await prisma.subStation.updateMany({ where: { region, repairedAt: null }, data: { repairedAt: new Date(now), auto: true } });
      done.push(region);
    }
  }
  if (done.length) await loadEruption();
  return done;
}

/* Un joueur met des points dans une sous-station. Tout se fait sous
   condition : pas plus de points qu'il n'en a, pas plus qu'il n'en manque. */
export async function contribute(companyId: string, region: string, wanted: number) {
  await loadEruption();
  const status = regionStatus(region);
  if (!cfg || status === "normal") return { error: "Cette sous-station n'est pas en panne" };
  if (status === "reparee") return { error: "Cette sous-station est déjà réparée" };
  if (status === "alerte") return { error: "Cette région n'est pas encore touchée" };
  const n = Math.floor(wanted);
  if (!Number.isFinite(n) || n < 1) return { error: "Nombre de points invalide" };

  return prisma.$transaction(async (tx) => {
    const st = (await tx.subStation.findUnique({ where: { region } })) as Station | null;
    if (!st || st.repairedAt) return { error: "Cette sous-station est déjà réparée" };
    const c = (await tx.company.findUnique({ where: { id: companyId }, select: { voltPoints: true } })) as { voltPoints: number } | null;
    const give = Math.min(n, c?.voltPoints ?? 0, st.cost - st.points);
    if (give < 1) return { error: "Vous n'avez pas de points de réparation : livrez du matériel électrique" };
    const took = await tx.company.updateMany({ where: { id: companyId, voltPoints: { gte: give } }, data: { voltPoints: { decrement: give } } });
    if (took.count === 0) return { error: "Vous n'avez pas assez de points" };
    const up = await tx.subStation.updateMany({ where: { region, repairedAt: null, points: { lte: st.cost - give } }, data: { points: { increment: give } } });
    if (up.count === 0) throw new Error("conflit");
    await tx.subStationGift.upsert({
      where: { region_companyId: { region, companyId } },
      create: { region, companyId, points: give, lastAt: new Date() },
      update: { points: { increment: give }, lastAt: new Date() },
    });
    const after = (await tx.subStation.findUnique({ where: { region } })) as Station;
    const repaired = after.points >= after.cost;
    if (repaired) await tx.subStation.update({ where: { region }, data: { repairedAt: new Date() } });
    return { ok: true as const, given: give, points: after.points, cost: after.cost, repaired };
  }).finally(() => void loadEruption());
}

/* La page des sous-stations : état, avancement, et qui a donné quoi. */
export async function eruptionSummary(companyId: string | null) {
  await loadEruption();
  if (!cfg) return null;
  const gifts = (await prisma.subStationGift.findMany({ orderBy: { points: "desc" } })) as { region: string; companyId: string; points: number }[];
  const ids = [...new Set(gifts.map((g) => g.companyId))];
  const companies = (await prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, liveryColor: true } })) as { id: string; name: string; liveryColor: string }[];
  const byId = new Map(companies.map((c) => [c.id, c]));
  const me = companyId ? ((await prisma.company.findUnique({ where: { id: companyId }, select: { voltPoints: true } })) as { voltPoints: number } | null) : null;
  const now = Date.now();
  return {
    startsAt: cfg.startsAt,
    active: eruptionActive(now),
    points: me?.voltPoints ?? 0,
    iconShare: ICON_SHARE,
    regions: cfg.order.map((region) => {
      const st = stations.get(region);
      const t = regionTimes(region)!;
      const mine = gifts.filter((g) => g.region === region);
      return {
        id: region,
        name: REGIONS.find((r) => r.id === region)?.name ?? region,
        status: regionStatus(region, now),
        alertAt: new Date(t.alertAt).toISOString(),
        cutAt: new Date(t.cutAt).toISOString(),
        autoAt: new Date(t.autoAt).toISOString(),
        cost: st?.cost ?? 0,
        points: st?.points ?? 0,
        repairedAt: st?.repairedAt ?? null,
        auto: st?.auto ?? false,
        contributors: mine.slice(0, 20).map((g) => ({
          companyId: g.companyId,
          name: byId.get(g.companyId)?.name ?? "?",
          liveryColor: byId.get(g.companyId)?.liveryColor ?? "#888",
          points: g.points,
          me: g.companyId === companyId,
        })),
        contributorsCount: mine.length,
        myPoints: mine.find((g) => g.companyId === companyId)?.points ?? 0,
      };
    }),
  };
}

/* L'icône électrique : au moins 10 % d'une sous-station, n'importe laquelle. */
export async function hasEruptionIcon(companyId: string) {
  const gifts = (await prisma.subStationGift.findMany({ where: { companyId }, select: { region: true, points: true } })) as { region: string; points: number }[];
  if (!gifts.length) return false;
  const costs = new Map(((await prisma.subStation.findMany({ select: { region: true, cost: true } })) as { region: string; cost: number }[]).map((s) => [s.region, s.cost]));
  return gifts.some((g) => g.points >= Math.ceil((costs.get(g.region) ?? Infinity) * ICON_SHARE));
}

/* Une région à réparer pour la destination d'un conteneur : on livre là où il manque du courant. */
export function brokenRegions(now = Date.now()) {
  if (!cfg) return [];
  return cfg.order.filter((r) => {
    const s = regionStatus(r, now);
    return s === "reduite" || s === "coupee";
  });
}
