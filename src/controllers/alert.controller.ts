import { Response } from "express";
import { prisma } from "../prisma";
import { AuthRequest } from "../middleware/auth.middleware";
import { ALERT_KINDS, MAX_ALERTS } from "../services/alert.service";

/* 2.1.1 (Premium) : les alertes personnalisées — lister, créer, supprimer */

async function premiumCompany(req: AuthRequest) {
  return prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true, isPremium: true } }) as Promise<{ id: string; isPremium: boolean } | null>;
}

export async function listAlerts(req: AuthRequest, res: Response) {
  const company = await premiumCompany(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const alerts = await prisma.customAlert.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "asc" } });
  res.json({ premium: company.isPremium, max: MAX_ALERTS, alerts });
}

export async function createAlert(req: AuthRequest, res: Response) {
  const company = await premiumCompany(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  if (!company.isPremium) return res.status(403).json({ error: "Les alertes personnalisées sont réservées au Premium" });
  const kind = String(req.body?.kind ?? "");
  const threshold = Number(req.body?.threshold);
  const targetId = req.body?.targetId ? String(req.body.targetId) : null;
  if (!(ALERT_KINDS as readonly string[]).includes(kind)) return res.status(400).json({ error: "Type d'alerte inconnu" });
  if (!Number.isFinite(threshold) || threshold < 0) return res.status(400).json({ error: "Seuil invalide" });
  if (kind === "USURE" && (threshold < 1 || threshold > 100)) return res.status(400).json({ error: "L'usure se règle de 1 à 100 %" });
  if (kind === "REVENTE") {
    if (!targetId) return res.status(400).json({ error: "Choisissez la rame à surveiller" });
    const t = await prisma.train.findFirst({ where: { id: targetId, companyId: company.id } });
    if (!t) return res.status(404).json({ error: "Train introuvable" });
  }
  const count = await prisma.customAlert.count({ where: { companyId: company.id } });
  if (count >= MAX_ALERTS) return res.status(409).json({ error: `${MAX_ALERTS} alertes au plus` });
  const alert = await prisma.customAlert.create({ data: { companyId: company.id, kind, threshold, targetId: kind === "REVENTE" ? targetId : null } });
  res.status(201).json(alert);
}

export async function deleteAlert(req: AuthRequest, res: Response) {
  const company = await premiumCompany(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const gone = await prisma.customAlert.deleteMany({ where: { id: String(req.params.id), companyId: company.id } });
  if (gone.count === 0) return res.status(404).json({ error: "Alerte introuvable" });
  res.json({ ok: true });
}
