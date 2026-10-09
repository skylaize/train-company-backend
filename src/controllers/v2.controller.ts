import { Response } from "express";
import { prisma } from "../prisma";
import { AuthRequest } from "../middleware/auth.middleware";
import { seasonView } from "../services/saison.service";
import { worldView } from "../services/world.service";
import { gazette } from "../services/gazette.service";
import { passView, claimFreeTier } from "../services/pass.service";
import { DLCS, ownedDlcs } from "../services/dlc.service";
import {
  ALLIANCE_MAX, ALLIANCE_COST, ALLIANCE_COLORS, MESSAGE_MAX, MESSAGE_COOLDOWN_MS, ALLY_STEP, ALLY_MAX_ALLIES,
  allianceOfCompany, allianceRanking, cleanName, invalidateAlliances, pruneMessages,
} from "../services/alliance.service";
import { allStationCounts } from "../services/hub.service";

/* ============================================================
   2.0 : saisons, alliances et Grand Chantier, vus par le joueur.
   ============================================================ */

async function myCompany(req: AuthRequest) {
  return prisma.company.findUnique({ where: { ownerId: req.userId as string } });
}
const err = (res: Response, status: number, error: string) => res.status(status).json({ error });

/* ---------------- saison ---------------- */

export async function getSeason(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  res.json(await seasonView(company.id));
}

/* ---------------- Grand Chantier ---------------- */

export async function getWorld(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  res.json(await worldView(company.id));
}

/* ---------------- alliances ---------------- */

export async function getAlliance(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const alliance = await allianceOfCompany(company.id);
  const ranking = await allianceRanking();
  const rules = { max: ALLIANCE_MAX, cost: ALLIANCE_COST, allyStep: ALLY_STEP, allyMaxAllies: ALLY_MAX_ALLIES, messageMax: MESSAGE_MAX, colors: ALLIANCE_COLORS };

  // invitations reçues, quand on n'a pas encore d'alliance
  if (!alliance) {
    const invites = (await prisma.allianceInvite.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } })) as { id: string; allianceId: string; createdAt: Date }[];
    const names = (await prisma.alliance.findMany({ where: { id: { in: invites.map((i) => i.allianceId) } } })) as { id: string; name: string; color: string }[];
    return res.json({
      alliance: null,
      rules,
      invites: invites.map((i) => ({ id: i.id, alliance: names.find((n) => n.id === i.allianceId)?.name ?? "—", color: names.find((n) => n.id === i.allianceId)?.color ?? "#94a3b8", at: i.createdAt })),
      ranking: ranking.slice(0, 10),
    });
  }

  await pruneMessages().catch(() => {});
  const members = (await prisma.allianceMember.findMany({ where: { allianceId: alliance.id }, orderBy: { joinedAt: "asc" } })) as { companyId: string; joinedAt: Date }[];
  const ids = members.map((m) => m.companyId);
  const [companies, lines, counts, messages, invites] = await Promise.all([
    prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, liveryColor: true } }),
    prisma.line.findMany({ where: { companyId: { in: ids } }, select: { companyId: true, departureStation: true, arrivalStation: true, stops: true } }),
    allStationCounts(),
    prisma.allianceMessage.findMany({ where: { allianceId: alliance.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.allianceInvite.findMany({ where: { allianceId: alliance.id } }),
  ]);
  const comp = companies as { id: string; name: string; liveryColor: string }[];
  const byId = new Map(comp.map((c) => [c.id, c]));

  // points de saison des membres
  const season = await prisma.season.findFirst({ where: { endedAt: null }, orderBy: { number: "desc" } });
  const entries = season
    ? ((await prisma.seasonEntry.findMany({ where: { seasonId: season.id, companyId: { in: ids } }, select: { companyId: true, points: true } })) as { companyId: string; points: number }[])
    : [];

  // gares desservies par au moins deux membres (avec une rame) : là où joue la correspondance d'alliance
  const served = new Map<string, Set<string>>();
  for (const id of ids) {
    for (const [st, n] of (counts as Map<string, Map<string, number>>).get(id) ?? new Map()) if (n > 0) served.set(st, (served.get(st) ?? new Set()).add(id));
  }
  const shared = [...served.entries()].filter(([, s]) => s.size >= 2).map(([station, s]) => ({ station, members: s.size, bonus: Math.round(ALLY_STEP * Math.min(ALLY_MAX_ALLIES, s.size - 1) * 100) }));

  const rank = ranking.find((r) => r.id === alliance.id);
  const invitedIds = (invites as { companyId: string }[]).map((i) => i.companyId);
  const invited = (await prisma.company.findMany({ where: { id: { in: invitedIds } }, select: { id: true, name: true } })) as { id: string; name: string }[];

  res.json({
    alliance: {
      id: alliance.id,
      name: alliance.name,
      color: alliance.color,
      discordUrl: alliance.discordUrl,
      founder: alliance.founderId === company.id,
      rank: rank?.rank ?? null,
      total: ranking.length,
      points: rank?.points ?? 0,
    },
    members: members.map((m) => ({
      companyId: m.companyId,
      name: byId.get(m.companyId)?.name ?? "—",
      liveryColor: byId.get(m.companyId)?.liveryColor ?? "#94a3b8",
      founder: m.companyId === alliance.founderId,
      isMe: m.companyId === company.id,
      points: entries.find((e) => e.companyId === m.companyId)?.points ?? 0,
      joinedAt: m.joinedAt,
    })),
    lines: (lines as { companyId: string; departureStation: string; arrivalStation: string; stops: string[] }[]).map((l) => ({
      companyId: l.companyId,
      color: byId.get(l.companyId)?.liveryColor ?? "#94a3b8",
      route: [l.departureStation, ...(l.stops ?? []), l.arrivalStation],
    })),
    shared,
    messages: (messages as { id: string; companyId: string; text: string; createdAt: Date }[]).map((m) => ({
      id: m.id,
      name: byId.get(m.companyId)?.name ?? "Ancien membre",
      color: byId.get(m.companyId)?.liveryColor ?? "#64748b",
      text: m.text,
      at: m.createdAt,
      mine: m.companyId === company.id,
    })),
    invited: invited.map((c) => c.name),
    rules,
    ranking: ranking.slice(0, 10),
  });
}

export async function createAlliance(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  if (await prisma.allianceMember.findUnique({ where: { companyId: company.id } })) return err(res, 409, "Vous êtes déjà dans une alliance");
  const name = cleanName(req.body.name);
  if (!name) return err(res, 400, "Un nom de 3 à 32 caractères, lettres, chiffres et ponctuation simple");
  const color = ALLIANCE_COLORS.includes(req.body.color) ? req.body.color : ALLIANCE_COLORS[0];
  if (company.balance < ALLIANCE_COST) return err(res, 409, `Il faut ${ALLIANCE_COST} pi. pour fonder une alliance`);
  if (await prisma.alliance.findUnique({ where: { name } })) return err(res, 409, "Ce nom est déjà pris");
  const alliance = await prisma.$transaction(async (tx: any) => {
    const a = await tx.alliance.create({ data: { name, color, founderId: company.id } });
    await tx.allianceMember.create({ data: { allianceId: a.id, companyId: company.id } });
    await tx.allianceInvite.deleteMany({ where: { companyId: company.id } });
    await tx.company.update({ where: { id: company.id }, data: { balance: { decrement: ALLIANCE_COST } } });
    await tx.transaction.create({ data: { companyId: company.id, type: "ALLIANCE", amount: -ALLIANCE_COST, description: `Fondation de l'alliance ${name}` } });
    return a;
  });
  invalidateAlliances();
  res.json({ ok: true, id: alliance.id });
}

export async function inviteToAlliance(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const alliance = await allianceOfCompany(company.id);
  if (!alliance) return err(res, 409, "Vous n'avez pas d'alliance");
  const count = await prisma.allianceMember.count({ where: { allianceId: alliance.id } });
  const pendingInvites = await prisma.allianceInvite.count({ where: { allianceId: alliance.id } });
  if (count + pendingInvites >= ALLIANCE_MAX) return err(res, 409, `Une alliance compte ${ALLIANCE_MAX} compagnies au plus, invitations comprises`);
  const name = String(req.body.companyName ?? "").trim();
  const target = await prisma.company.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
  if (!target) return err(res, 404, "Aucune compagnie de ce nom");
  if (target.id === company.id) return err(res, 400, "Vous êtes déjà membre");
  if (await prisma.allianceMember.findUnique({ where: { companyId: target.id } })) return err(res, 409, `${target.name} fait déjà partie d'une alliance`);
  await prisma.allianceInvite.upsert({
    where: { allianceId_companyId: { allianceId: alliance.id, companyId: target.id } },
    create: { allianceId: alliance.id, companyId: target.id },
    update: {},
  });
  const { sendToCompany } = await import("../services/push.service");
  await sendToCompany(target.id, { title: "Invitation d'alliance", body: `${company.name} vous invite à rejoindre ${alliance.name}.`, url: "/dashboard", tag: "alliance" }).catch(() => {});
  res.json({ ok: true, name: target.name });
}

export async function answerInvite(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const invite = await prisma.allianceInvite.findFirst({ where: { id: req.params.id, companyId: company.id } });
  if (!invite) return err(res, 404, "Invitation introuvable");
  if (req.body.accept !== true) {
    await prisma.allianceInvite.delete({ where: { id: invite.id } });
    return res.json({ ok: true });
  }
  if (await prisma.allianceMember.findUnique({ where: { companyId: company.id } })) return err(res, 409, "Quittez d'abord votre alliance");
  const count = await prisma.allianceMember.count({ where: { allianceId: invite.allianceId } });
  if (count >= ALLIANCE_MAX) return err(res, 409, "Cette alliance est complète");
  await prisma.$transaction([
    prisma.allianceMember.create({ data: { allianceId: invite.allianceId, companyId: company.id } }),
    prisma.allianceInvite.deleteMany({ where: { companyId: company.id } }),
  ]);
  invalidateAlliances();
  res.json({ ok: true });
}

export async function leaveAlliance(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const alliance = await allianceOfCompany(company.id);
  if (!alliance) return err(res, 409, "Vous n'avez pas d'alliance");
  await prisma.allianceMember.delete({ where: { companyId: company.id } });
  const left = (await prisma.allianceMember.findMany({ where: { allianceId: alliance.id }, orderBy: { joinedAt: "asc" } })) as { companyId: string }[];
  if (left.length === 0) {
    // dernière compagnie partie : l'alliance disparaît
    await prisma.$transaction([
      prisma.allianceInvite.deleteMany({ where: { allianceId: alliance.id } }),
      prisma.allianceMessage.deleteMany({ where: { allianceId: alliance.id } }),
      prisma.alliance.delete({ where: { id: alliance.id } }),
    ]);
  } else if (alliance.founderId === company.id) {
    // le plus ancien membre reprend la main
    await prisma.alliance.update({ where: { id: alliance.id }, data: { founderId: left[0].companyId } });
  }
  invalidateAlliances();
  res.json({ ok: true });
}

export async function kickMember(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const alliance = await allianceOfCompany(company.id);
  if (!alliance || alliance.founderId !== company.id) return err(res, 403, "Seul le fondateur peut exclure un membre");
  const target = String(req.body.companyId ?? "");
  if (target === company.id) return err(res, 400, "Utilisez « Quitter l'alliance »");
  const m = await prisma.allianceMember.findFirst({ where: { allianceId: alliance.id, companyId: target } });
  if (!m) return err(res, 404, "Ce membre n'est pas dans votre alliance");
  await prisma.allianceMember.delete({ where: { id: m.id } });
  invalidateAlliances();
  res.json({ ok: true });
}

export async function updateAlliance(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const alliance = await allianceOfCompany(company.id);
  if (!alliance || alliance.founderId !== company.id) return err(res, 403, "Seul le fondateur peut modifier l'alliance");
  const data: { discordUrl?: string | null; color?: string } = {};
  if (req.body.discordUrl !== undefined) {
    const url = String(req.body.discordUrl ?? "").trim();
    if (url && !/^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(url)) return err(res, 400, "Un lien d'invitation Discord (https://discord.gg/…)");
    data.discordUrl = url || null;
  }
  if (req.body.color !== undefined && ALLIANCE_COLORS.includes(req.body.color)) data.color = req.body.color;
  await prisma.alliance.update({ where: { id: alliance.id }, data });
  res.json({ ok: true });
}

const lastPost = new Map<string, number>();
export async function postMessage(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const alliance = await allianceOfCompany(company.id);
  if (!alliance) return err(res, 409, "Vous n'avez pas d'alliance");
  const text = String(req.body.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return err(res, 400, "Message vide");
  if (text.length > MESSAGE_MAX) return err(res, 400, `${MESSAGE_MAX} caractères au plus`);
  const last = lastPost.get(company.id) ?? 0;
  if (Date.now() - last < MESSAGE_COOLDOWN_MS) return err(res, 429, "Un message toutes les quinze secondes");
  lastPost.set(company.id, Date.now());
  await prisma.allianceMessage.create({ data: { allianceId: alliance.id, companyId: company.id, text } });
  res.json({ ok: true });
}

export async function deleteMessage(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const alliance = await allianceOfCompany(company.id);
  if (!alliance) return err(res, 409, "Vous n'avez pas d'alliance");
  const m = await prisma.allianceMessage.findFirst({ where: { id: req.params.id, allianceId: alliance.id } });
  if (!m) return err(res, 404, "Message introuvable");
  if (m.companyId !== company.id && alliance.founderId !== company.id) return err(res, 403, "Seuls l'auteur et le fondateur peuvent retirer un message");
  await prisma.allianceMessage.delete({ where: { id: m.id } });
  res.json({ ok: true });
}

/* ---------------- la Gazette du Rail, les extensions ---------------- */

export async function getGazette(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  res.json(await gazette(company.id));
}

export async function getDlcs(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const owned = await ownedDlcs(company.id);
  res.json({
    isPremium: company.isPremium,
    dlcs: DLCS.map((d) => ({ id: d.id, name: d.name, tagline: d.tagline, priceCents: d.priceCents, premium: d.premium, owned: owned.has(d.id), models: d.models, stations: d.stations, features: d.features })),
  });
}

/* ---------------- le Pass de saison ---------------- */

export async function getPass(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  res.json(await passView(company.id));
}

export async function claimPass(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const r = await claimFreeTier(company.id, Number(req.body?.tier));
  if (!("ok" in r)) return err(res, r.status, r.error);
  res.json(r);
}
