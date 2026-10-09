import { prisma } from "../prisma";

/* ============================================================
   Le Grand Chantier (2.0).

   Un objectif commun à tout le serveur : le tunnel du Mont-Blanc. Chaque
   trajet voyageurs de chaque joueur le fait avancer d'un mètre. À son
   ouverture, Turin et Zurich rejoignent la carte pour tout le monde.

   La longueur se règle avec WORLD_TUNNEL_TARGET (trajets), pour l'adapter
   au nombre de joueurs.
   ============================================================ */

export const TUNNEL_ID = "mont-blanc";
export const TUNNEL_NAME = "Le tunnel du Mont-Blanc";
export const TUNNEL_STATIONS = ["Turin", "Zurich"];
export const BUILDER_EMBLEM = "tunnel";
export const BUILDER_MIN = 300; // trajets pour l'emblème « Bâtisseur du tunnel »

function target() {
  const n = Number(process.env.WORLD_TUNNEL_TARGET);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 200_000;
}

const pending = new Map<string, number>();
let completedCache: boolean | null = null;

export function contribute(companyId: string, n = 1) {
  pending.set(companyId, (pending.get(companyId) ?? 0) + n);
}

export async function ensureProject() {
  const p = await prisma.worldProject.findUnique({ where: { id: TUNNEL_ID } });
  if (p) return p;
  return prisma.worldProject.create({ data: { id: TUNNEL_ID, name: TUNNEL_NAME, target: target() } });
}

/* En fin de tour : une écriture par compagnie et une pour le chantier.
   Renvoie true au tour où le tunnel s'ouvre. */
export async function flushWorld() {
  if (pending.size === 0) return false;
  const batch = new Map(pending);
  pending.clear();
  const project = await ensureProject();
  if (project.completedAt) return false;
  const total = [...batch.values()].reduce((a, b) => a + b, 0);
  for (const [companyId, amount] of batch) {
    await prisma.worldContribution.upsert({
      where: { projectId_companyId: { projectId: TUNNEL_ID, companyId } },
      create: { projectId: TUNNEL_ID, companyId, amount },
      update: { amount: { increment: amount } },
    });
  }
  const updated = await prisma.worldProject.update({ where: { id: TUNNEL_ID }, data: { progress: { increment: total } } });
  if (updated.progress >= updated.target && !updated.completedAt) {
    const done = await prisma.worldProject.updateMany({ where: { id: TUNNEL_ID, completedAt: null }, data: { completedAt: new Date() } });
    completedCache = true;
    return done.count > 0;
  }
  return false;
}

export async function tunnelOpen() {
  if (completedCache !== null) return completedCache;
  const p = await prisma.worldProject.findUnique({ where: { id: TUNNEL_ID } });
  completedCache = Boolean(p?.completedAt);
  // on ne garde le « non » en mémoire qu'une minute
  if (!completedCache) setTimeout(() => (completedCache = null), 60_000);
  return completedCache;
}

/* Une gare réservée au tunnel ne peut servir qu'une fois le tunnel ouvert. */
export async function stationLocked(station: string) {
  return TUNNEL_STATIONS.includes(station) && !(await tunnelOpen());
}

export async function worldView(companyId: string) {
  const project = await ensureProject();
  const [mine, top, contributors] = await Promise.all([
    prisma.worldContribution.findUnique({ where: { projectId_companyId: { projectId: TUNNEL_ID, companyId } } }),
    prisma.worldContribution.findMany({ where: { projectId: TUNNEL_ID }, orderBy: { amount: "desc" }, take: 5 }),
    prisma.worldContribution.count({ where: { projectId: TUNNEL_ID } }),
  ]);
  const names = (await prisma.company.findMany({
    where: { id: { in: (top as { companyId: string }[]).map((t) => t.companyId) } },
    select: { id: true, name: true, liveryColor: true },
  })) as { id: string; name: string; liveryColor: string }[];
  const byId = new Map(names.map((n) => [n.id, n]));
  return {
    id: project.id,
    name: project.name,
    target: project.target,
    progress: Math.min(project.target, project.progress),
    completedAt: project.completedAt,
    stations: TUNNEL_STATIONS,
    contributors,
    mine: mine?.amount ?? 0,
    builderMin: BUILDER_MIN,
    top: (top as { companyId: string; amount: number }[]).map((t, i) => ({
      rank: i + 1,
      name: byId.get(t.companyId)?.name ?? "—",
      liveryColor: byId.get(t.companyId)?.liveryColor ?? "#94a3b8",
      amount: t.amount,
      isMe: t.companyId === companyId,
    })),
  };
}

export async function isBuilder(companyId: string) {
  const c = await prisma.worldContribution.findUnique({ where: { projectId_companyId: { projectId: TUNNEL_ID, companyId } } });
  return (c?.amount ?? 0) >= BUILDER_MIN;
}
