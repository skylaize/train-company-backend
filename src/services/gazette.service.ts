import { severeWeather } from "./realweather.service";
import { WRECK_KINDS } from "./wreck.service";
import { prisma } from "../prisma";
import { worldView } from "./world.service";

/* ============================================================
   La Gazette du Rail (2.0).

   Un petit journal du réseau, refait toutes les dix minutes à partir des
   dernières 24 heures : le plus beau trajet, la compagnie qui a le plus
   gagné, le roi du fret, l'avancée du tunnel, les nouveaux venus et les
   mésaventures sur la voie. C'est ce qui fait sentir qu'on n'est pas seul
   sur la carte, même quand on joue à une heure creuse.
   ============================================================ */

export interface Headline {
  kind: "record" | "fortune" | "fret" | "chantier" | "arrivees" | "voie" | "calme" | "epave" | "meteo";
  title: string;
  body: string;
}

let cache: { at: number; data: { date: string; edition: number; headlines: Headline[] } } | null = null;
const fmt = (n: number) => Math.round(n).toLocaleString("fr-FR").replace(/[  ]/g, " ");

export async function gazette(viewerCompanyId: string) {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.data;
  const since = new Date(Date.now() - 24 * 3600_000);

  const [best, earners, freight, arrivals, trackIncidents, world] = await Promise.all([
    prisma.transaction.findFirst({ where: { type: "REVENU_LIGNE", createdAt: { gte: since } }, orderBy: { amount: "desc" }, select: { companyId: true, amount: true, description: true } }),
    (prisma.transaction.groupBy as any)({ by: ["companyId"], where: { type: { in: ["REVENU_LIGNE", "FRET"] }, amount: { gt: 0 }, createdAt: { gte: since } }, _sum: { amount: true }, orderBy: { _sum: { amount: "desc" } }, take: 1 }),
    (prisma.transaction.groupBy as any)({ by: ["companyId"], where: { type: "FRET", createdAt: { gte: since } }, _count: { _all: true }, orderBy: { _count: { companyId: "desc" } }, take: 1 }),
    prisma.company.count({ where: { createdAt: { gte: since } } }),
    prisma.incident.count({ where: { createdAt: { gte: since }, OR: [{ message: { contains: "sanglier" } }, { message: { contains: "branche" } }, { message: { contains: "objet abandonné" } }, { message: { contains: "troupeau" } }] } }),
    worldView(viewerCompanyId).catch(() => null),
  ]);

  const ids = [best?.companyId, earners?.[0]?.companyId, freight?.[0]?.companyId].filter(Boolean) as string[];
  const names = new Map(
    ((await prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) as { id: string; name: string }[]).map((c) => [c.id, c.name])
  );

  const headlines: Headline[] = [];
  if (best && best.amount > 0) {
    const route = /sur (.+?)( ·|$)/.exec(best.description ?? "")?.[1] ?? "le réseau";
    headlines.push({ kind: "record", title: `Trajet record sur ${route}`, body: `${names.get(best.companyId) ?? "Une compagnie"} a encaissé ${fmt(best.amount)} pi. en un seul trajet.` });
  }
  const top = earners?.[0];
  if (top?._sum?.amount) {
    headlines.push({ kind: "fortune", title: `${names.get(top.companyId) ?? "Une compagnie"}, la plus grosse recette du jour`, body: `${fmt(top._sum.amount)} pi. de recettes en 24 heures.` });
  }
  const fr = freight?.[0];
  if (fr?._count?._all) {
    headlines.push({ kind: "fret", title: `${names.get(fr.companyId) ?? "Une compagnie"} règne sur le fret`, body: `${fr._count._all} livraison${fr._count._all > 1 ? "s" : ""} en 24 heures.` });
  }
  if (world && !world.completedAt) {
    const pct = Math.floor((world.progress / Math.max(1, world.target)) * 1000) / 10;
    headlines.push({ kind: "chantier", title: `Mont-Blanc : le tunnel à ${String(pct).replace(".", ",")} %`, body: `${fmt(world.target - world.progress)} trajets avant que Turin et Zurich n'apparaissent sur la carte.` });
  } else if (world?.completedAt) {
    headlines.push({ kind: "chantier", title: "Le tunnel du Mont-Blanc est ouvert", body: "Turin et Zurich attendent vos lignes." });
  }
  if (trackIncidents > 0) {
    headlines.push({ kind: "voie", title: `${trackIncidents} incident${trackIncidents > 1 ? "s" : ""} sur la voie`, body: "Sangliers, branches et objets oubliés : les conducteurs ont eu du travail." });
  }
  if (arrivals > 0) {
    headlines.push({ kind: "arrivees", title: `${arrivals} nouvelle${arrivals > 1 ? "s" : ""} compagnie${arrivals > 1 ? "s" : ""}`, body: "Le réseau s'agrandit. Les quais aussi vont se remplir." });
  }
  // 2.0 : les épaves du jour
  const since24 = new Date(Date.now() - 86_400_000);
  const [legend, revived] = await Promise.all([
    prisma.wreck.findFirst({ where: { rarity: "LEGENDAIRE", discoveredAt: { gte: since24 } }, orderBy: { discoveredAt: "desc" }, include: { company: { select: { name: true } } } }),
    prisma.wreck.findFirst({ where: { completedAt: { gte: since24 } }, orderBy: { completedAt: "desc" }, include: { company: { select: { name: true } } } }),
  ]);
  if (legend) {
    const who = (legend as unknown as { company?: { name: string } | null }).company?.name;
    headlines.push({ kind: "epave", title: `Une épave légendaire près de ${legend.station}`, body: who ? `${who} l'a rachetée : la ${legend.serial} va reprendre du service.` : `La ${legend.serial} attend un repreneur. Premier arrivé, premier servi.` });
  }
  if (revived && revived.id !== legend?.id) {
    const who = (revived as unknown as { company?: { name: string } | null }).company?.name ?? "Une compagnie";
    headlines.push({ kind: "epave", title: `${who} remet en service la ${revived.serial}`, body: `${WRECK_KINDS[revived.kind]?.label ?? "Une vieille rame"} roule à nouveau, ${new Date().getFullYear() - revived.year} ans après sa première sortie.` });
  }
  // 2.0 : la vraie météo, quand elle gêne les rames
  const severe = await severeWeather().catch(() => new Map());
  const WX: [string, string, string][] = [
    ["ORAGE", "Orages", "Retards fréquents sur les lignes qui y passent."],
    ["NEIGE", "Neige", "Rames ralenties, prudence sur les quais."],
    ["VERGLAS", "Verglas", "Le risque de retard double sur ces lignes."],
    ["BROUILLARD", "Brouillard", "Les conducteurs lèvent le pied."],
    ["CANICULE", "Canicule", "Le matériel souffre : prévoyez des révisions."],
  ];
  for (const [kind, title, body] of WX) {
    const where = (severe as Map<string, string[]>).get(kind);
    if (!where?.length) continue;
    const list = where.length > 3 ? `${where.slice(0, 3).join(", ")} et ${where.length - 3} autre${where.length > 4 ? "s" : ""}` : where.join(", ").replace(/, ([^,]*)$/, " et $1");
    headlines.push({ kind: "meteo", title: `${title} sur ${list}`, body });
    break;
  }
  if (headlines.length === 0) headlines.push({ kind: "calme", title: "Journée calme sur le réseau", body: "Rien à signaler. Les rames roulent, les voyageurs arrivent à l'heure." });

  const now = new Date();
  const data = {
    date: new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long" }).format(now),
    edition: Math.floor((now.getTime() - Date.UTC(2026, 9, 10)) / 86_400_000) + 1,
    headlines: headlines.slice(0, 5),
  };
  cache = { at: Date.now(), data };
  return data;
}
