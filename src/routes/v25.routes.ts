import { Router, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { campaignView, startCampaign, claimCampaignStep } from "../services/campaign.service";
import { mentorView, setMentorOpen, chooseMentor, endMentorship, sendNote, mentorInvite } from "../services/mentor.service";

/* 2.5 : campagnes régionales et compagnonnage */
export const v25Router = Router();

async function companyId(req: AuthRequest) {
  const c = (await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true } })) as { id: string } | null;
  return c?.id ?? null;
}
const none = (res: Response) => res.status(404).json({ error: "Créez d'abord votre compagnie" });
const send = (res: Response, r: { ok: boolean; error?: string }) => (r.ok ? res.json(r) : res.status(409).json({ error: r.error }));

// ---- campagnes ----
v25Router.get("/campaigns", requireAuth, async (req: AuthRequest, res) => {
  const id = await companyId(req);
  if (!id) return none(res);
  res.json(await campaignView(id));
});
v25Router.post("/campaigns/start", requireAuth, async (req: AuthRequest, res) => {
  const id = await companyId(req);
  if (!id) return none(res);
  send(res, await startCampaign(id, String(req.body?.region ?? "")));
});
v25Router.post("/campaigns/claim", requireAuth, async (req: AuthRequest, res) => {
  const id = await companyId(req);
  if (!id) return none(res);
  send(res, await claimCampaignStep(id));
});

// ---- compagnonnage ----
v25Router.get("/mentor", requireAuth, async (req: AuthRequest, res) => {
  const id = await companyId(req);
  if (!id) return none(res);
  res.json(await mentorView(id));
});
v25Router.get("/mentor/invite", requireAuth, async (req: AuthRequest, res) => {
  const id = await companyId(req);
  if (!id) return none(res);
  res.json(await mentorInvite(id));
});
v25Router.post("/mentor/open", requireAuth, async (req: AuthRequest, res) => {
  const id = await companyId(req);
  if (!id) return none(res);
  send(res, await setMentorOpen(id, Boolean(req.body?.open), req.body?.pitch ? String(req.body.pitch) : null));
});
v25Router.post("/mentor/choose", requireAuth, async (req: AuthRequest, res) => {
  const id = await companyId(req);
  if (!id) return none(res);
  send(res, await chooseMentor(id, String(req.body?.mentorId ?? "")));
});
v25Router.post("/mentor/:id/end", requireAuth, async (req: AuthRequest, res) => {
  const id = await companyId(req);
  if (!id) return none(res);
  send(res, await endMentorship(id, String((req as unknown as { params: { id: string } }).params.id)));
});
v25Router.post("/mentor/:id/note", requireAuth, async (req: AuthRequest, res) => {
  const id = await companyId(req);
  if (!id) return none(res);
  send(res, await sendNote(id, String((req as unknown as { params: { id: string } }).params.id), String(req.body?.text ?? "")));
});
