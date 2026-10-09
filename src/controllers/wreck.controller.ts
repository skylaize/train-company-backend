import { Response } from "express";
import { prisma } from "../prisma";
import { AuthRequest } from "../middleware/auth.middleware";
import { wrecksFor, buyWreck, restoreOrgan, commissionWreck } from "../services/wreck.service";

/* 2.0 : les épaves à restaurer, vues par le joueur. */

async function myCompanyId(req: AuthRequest) {
  return (await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true } }))?.id ?? null;
}

type R = { ok: true; data: unknown } | { ok: false; status: number; error: string };
const send = (res: Response, r: R) => (r.ok ? res.json(r.data) : res.status(r.status).json({ error: r.error }));

export async function getWrecks(req: AuthRequest, res: Response) {
  const id = await myCompanyId(req);
  if (!id) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  res.json(await wrecksFor(id));
}

export async function postBuyWreck(req: AuthRequest, res: Response) {
  const id = await myCompanyId(req);
  if (!id) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  send(res, await buyWreck(id, String(req.params.id)));
}

export async function postRestore(req: AuthRequest, res: Response) {
  const id = await myCompanyId(req);
  if (!id) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  send(res, await restoreOrgan(id, String(req.params.id), String(req.body?.organ ?? "")));
}

export async function postCommission(req: AuthRequest, res: Response) {
  const id = await myCompanyId(req);
  if (!id) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  send(res, await commissionWreck(id, String(req.params.id), req.body?.name));
}
