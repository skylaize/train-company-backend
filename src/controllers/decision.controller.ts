import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { listForCompany, lockedReasons, resolveDecision } from "../services/decision.service";
import { activeStationEvents, upcomingStationEvents } from "../services/station.service";

async function companyOf(req: AuthRequest) {
  return prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true } });
}

/* GET /decisions : les décisions ouvertes et celles des dernières 24 h. */
export async function listDecisions(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  return res.json({ decisions: await listForCompany(company.id) });
}

/* POST /decisions/:id/choose { choiceId } */
export async function chooseDecision(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const choiceId = typeof req.body?.choiceId === "string" ? req.body.choiceId : "";
  const d = await prisma.decision.findUnique({ where: { id: req.params.id } });
  if (!d || d.companyId !== company.id) return res.status(404).json({ error: "Décision introuvable" });
  // un choix bloqué (plus de rame libre, dépôt plein) est refusé ici aussi, pas seulement grisé
  const choices = await lockedReasons(d as any, d.choices as any);
  const picked = choices.find((c) => c.id === choiceId);
  if (picked?.locked) return res.status(400).json({ error: picked.locked });
  const r = await resolveDecision(d.id, company.id, choiceId);
  if (!("ok" in r)) return res.status(r.status).json({ error: r.error });
  return res.json({ outcome: r.outcome, tone: r.tone });
}

/* ============================================================
   GET /news : le fil du réseau (1.6).

   Rien de stocké exprès : on relit ce qui s'est passé. Vos arrivées et
   livraisons, les lignes que les autres compagnies viennent d'ouvrir, les
   événements en gare, vos décisions. Le plus récent d'abord.
   ============================================================ */

type Item = { id: string; at: Date; text: string; tone: "moi" | "rival" | "reseau" | "alerte" };

const TRIP = /^(?:Trajet voyageurs|Trajet de nuit) : (.+?) sur .+? → (.+?)(?: · affluence)?$/;

export async function listNews(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const since = new Date(Date.now() - 24 * 3600_000);

  const [mine, rivals, live, soon, decisions] = await Promise.all([
    prisma.transaction.findMany({
      where: { companyId: company.id, type: { in: ["REVENU_LIGNE", "FRET"] } },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
    prisma.line.findMany({
      where: { companyId: { not: company.id }, createdAt: { gt: since } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, departureStation: true, arrivalStation: true, createdAt: true, company: { select: { name: true } } },
    }),
    activeStationEvents(),
    upcomingStationEvents(),
    prisma.decision.findMany({
      where: { companyId: company.id, createdAt: { gt: since } },
      orderBy: { createdAt: "desc" },
      take: 4,
      select: { id: true, title: true, status: true, createdAt: true, resolvedAt: true },
    }),
  ]);

  const items: Item[] = [];
  for (const t of mine as { id: string; type: string; amount: number; description: string; createdAt: Date }[]) {
    const m = t.description.match(TRIP);
    const text = m
      ? `${m[1]} arrivée à ${m[2]} · +${t.amount} pi.`
      : t.type === "FRET"
        ? `${t.description.replace(/^Livraison /, "Livraison ")} · +${t.amount} pi.`
        : `${t.description} · +${t.amount} pi.`;
    items.push({ id: `t-${t.id}`, at: t.createdAt, text, tone: "moi" });
  }
  for (const l of rivals as { id: string; departureStation: string; arrivalStation: string; createdAt: Date; company: { name: string } }[]) {
    items.push({ id: `l-${l.id}`, at: l.createdAt, text: `${l.company.name} ouvre ${l.departureStation} → ${l.arrivalStation}`, tone: "rival" });
  }
  for (const e of live.slice(0, 3)) {
    const pct = Math.round((e.multiplier - 1) * 100);
    items.push({ id: `e-${e.id}`, at: e.startsAt, text: `${e.label} à ${e.station} : ${pct >= 0 ? "+" : ""}${pct} % de voyageurs`, tone: "reseau" });
  }
  for (const e of soon.slice(0, 2)) {
    const hour = new Date(e.startsAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
    items.push({ id: `u-${e.id}`, at: new Date(), text: `Annoncé à ${hour} : ${e.label.toLowerCase()} à ${e.station}`, tone: "reseau" });
  }
  for (const d of decisions as { id: string; title: string; status: string; createdAt: Date; resolvedAt: Date | null }[]) {
    if (d.status === "OUVERTE") items.push({ id: `d-${d.id}`, at: d.createdAt, text: `Décision à prendre : ${d.title}`, tone: "alerte" });
    else if (d.resolvedAt) items.push({ id: `d-${d.id}-r`, at: d.resolvedAt, text: `${d.status === "EXPIREE" ? "Tranché sans vous" : "Décision prise"} : ${d.title}`, tone: "moi" });
  }

  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  return res.json({ items: items.slice(0, 15) });
}
