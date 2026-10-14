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
  APPLY_MAX_PENDING, APPLY_MESSAGE_MAX, PITCH_MAX,
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
  const rules = {
    max: ALLIANCE_MAX, cost: ALLIANCE_COST, allyStep: ALLY_STEP, allyMaxAllies: ALLY_MAX_ALLIES, messageMax: MESSAGE_MAX, colors: ALLIANCE_COLORS,
    applyMax: APPLY_MAX_PENDING, applyMessageMax: APPLY_MESSAGE_MAX, pitchMax: PITCH_MAX,
  };

  // invitations reçues, quand on n'a pas encore d'alliance
  if (!alliance) {
    const invites = (await prisma.allianceInvite.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } })) as { id: string; allianceId: string; createdAt: Date }[];
    const names = (await prisma.alliance.findMany({ where: { id: { in: invites.map((i) => i.allianceId) } } })) as { id: string; name: string; color: string }[];
    const mine = (await prisma.allianceApplication.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } })) as { id: string; allianceId: string; message: string; createdAt: Date }[];
    const directory = await allianceDirectory(ranking);
    const appliedTo = new Set(mine.map((a) => a.allianceId));
    return res.json({
      alliance: null,
      rules,
      invites: invites.map((i) => ({ id: i.id, alliance: names.find((n) => n.id === i.allianceId)?.name ?? "—", color: names.find((n) => n.id === i.allianceId)?.color ?? "#94a3b8", at: i.createdAt })),
      // 2.0.2 : les alliances qui recrutent et mes candidatures en attente
      directory: directory.map((d) => ({ ...d, applied: appliedTo.has(d.id) })),
      myApplications: mine.map((a) => {
        const r = ranking.find((x) => x.id === a.allianceId);
        return { id: a.id, allianceId: a.allianceId, alliance: r?.name ?? "—", color: r?.color ?? "#94a3b8", message: a.message, at: a.createdAt };
      }),
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

  // 2.0.2 : candidatures reçues, montrées au fondateur seulement
  let applications: { id: string; companyId: string; name: string; liveryColor: string; points: number; lines: number; message: string; at: Date }[] = [];
  if (alliance.founderId === company.id) {
    const apps = (await prisma.allianceApplication.findMany({ where: { allianceId: alliance.id }, orderBy: { createdAt: "asc" } })) as { id: string; companyId: string; message: string; createdAt: Date }[];
    if (apps.length) {
      const appIds = apps.map((a) => a.companyId);
      const [who, appLines, appEntries] = await Promise.all([
        prisma.company.findMany({ where: { id: { in: appIds } }, select: { id: true, name: true, liveryColor: true } }) as Promise<{ id: string; name: string; liveryColor: string }[]>,
        prisma.line.findMany({ where: { companyId: { in: appIds } }, select: { companyId: true } }) as Promise<{ companyId: string }[]>,
        season
          ? (prisma.seasonEntry.findMany({ where: { seasonId: season.id, companyId: { in: appIds } }, select: { companyId: true, points: true } }) as Promise<{ companyId: string; points: number }[]>)
          : Promise.resolve([] as { companyId: string; points: number }[]),
      ]);
      applications = apps
        .filter((a) => who.some((w) => w.id === a.companyId))
        .map((a) => {
          const w = who.find((x) => x.id === a.companyId)!;
          return {
            id: a.id,
            companyId: a.companyId,
            name: w.name,
            liveryColor: w.liveryColor,
            points: appEntries.find((e) => e.companyId === a.companyId)?.points ?? 0,
            lines: appLines.filter((l) => l.companyId === a.companyId).length,
            message: a.message,
            at: a.createdAt,
          };
        });
    }
  }

  res.json({
    alliance: {
      id: alliance.id,
      name: alliance.name,
      color: alliance.color,
      discordUrl: alliance.discordUrl,
      recruiting: (alliance as { recruiting?: boolean }).recruiting ?? true,
      pitch: (alliance as { pitch?: string | null }).pitch ?? null,
      livery: (alliance as { livery?: string | null }).livery ?? null, // 2.1
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
    applications,
    // 2.1 : les livrées communes que ce membre peut poser (coffret d'alliance)
    liveryChoices: await (async () => {
      const { unlockedFor } = await import("../services/shop.service");
      return [...(await unlockedFor(company.id)).allianceLiveries];
    })(),
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
    await tx.allianceApplication.deleteMany({ where: { companyId: company.id } });
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
    prisma.allianceApplication.deleteMany({ where: { companyId: company.id } }),
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
      prisma.allianceApplication.deleteMany({ where: { allianceId: alliance.id } }),
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
  const data: { discordUrl?: string | null; color?: string; recruiting?: boolean; pitch?: string | null; livery?: string | null } = {};
  if (typeof req.body.recruiting === "boolean") data.recruiting = req.body.recruiting;
  if (req.body.pitch !== undefined) {
    const pitch = String(req.body.pitch ?? "").replace(/\s+/g, " ").trim();
    if (pitch.length > PITCH_MAX) return err(res, 400, `${PITCH_MAX} caractères au plus pour la présentation`);
    data.pitch = pitch || null;
  }
  if (req.body.discordUrl !== undefined) {
    const url = String(req.body.discordUrl ?? "").trim();
    if (url && !/^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(url)) return err(res, 400, "Un lien d'invitation Discord (https://discord.gg/…)");
    data.discordUrl = url || null;
  }
  if (req.body.color !== undefined && ALLIANCE_COLORS.includes(req.body.color)) data.color = req.body.color;
  /* 2.1 : la livrée commune. Le fondateur la pose s'il possède le coffret
     d'alliance, ou un membre qui le possède la lui a offerte (voir setAllianceLivery). */
  if (req.body.livery !== undefined) {
    const { unlockedFor } = await import("../services/shop.service");
    const u = await unlockedFor(company.id);
    if (req.body.livery !== null && !u.allianceLiveries.has(String(req.body.livery).toLowerCase())) return err(res, 403, "Le coffret d'alliance se trouve en boutique");
    data.livery = req.body.livery === null ? null : String(req.body.livery).toLowerCase();
  }
  await prisma.alliance.update({ where: { id: alliance.id }, data });
  res.json({ ok: true });
}

/* ---------------- 2.0.2 : candidatures ----------------
   Une compagnie sans alliance postule auprès d'une alliance qui recrute
   (trois candidatures en attente au plus). Le fondateur accepte ou refuse ;
   accepter fait entrer la compagnie et retire ses autres candidatures. */

type RankRow = { id: string; name: string; color: string; members: number; points: number; rank: number };

/* Les alliances qui recrutent et ont encore de la place, invitations comprises. */
async function allianceDirectory(ranking: RankRow[]) {
  const open = (await prisma.alliance.findMany({ where: { recruiting: true }, select: { id: true, name: true, color: true, pitch: true, founderId: true, discordUrl: true } })) as {
    id: string; name: string; color: string; pitch: string | null; founderId: string; discordUrl: string | null;
  }[];
  if (!open.length) return [];
  const ids = open.map((a) => a.id);
  const [invites, founders] = await Promise.all([
    prisma.allianceInvite.findMany({ where: { allianceId: { in: ids } }, select: { allianceId: true } }) as Promise<{ allianceId: string }[]>,
    prisma.company.findMany({ where: { id: { in: open.map((a) => a.founderId) } }, select: { id: true, name: true } }) as Promise<{ id: string; name: string }[]>,
  ]);
  return open
    .map((a) => {
      const r = ranking.find((x) => x.id === a.id);
      const members = r?.members ?? 0;
      const reserved = invites.filter((i) => i.allianceId === a.id).length;
      return {
        id: a.id,
        name: a.name,
        color: a.color,
        pitch: a.pitch,
        founder: founders.find((f) => f.id === a.founderId)?.name ?? "—",
        members,
        room: ALLIANCE_MAX - members - reserved,
        points: r?.points ?? 0,
        rank: r?.rank ?? null,
      };
    })
    .filter((a) => a.members > 0 && a.room > 0)
    .sort((x, y) => (x.rank ?? 999) - (y.rank ?? 999));
}

/* Place libre pour une compagnie donnée : ses propres invitations ne comptent pas. */
async function roomFor(allianceId: string, companyId: string) {
  const [members, invites] = await Promise.all([
    prisma.allianceMember.count({ where: { allianceId } }),
    prisma.allianceInvite.count({ where: { allianceId, companyId: { not: companyId } } }),
  ]);
  return ALLIANCE_MAX - members - invites;
}

export async function applyToAlliance(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  if (await prisma.allianceMember.findUnique({ where: { companyId: company.id } })) return err(res, 409, "Vous êtes déjà dans une alliance");
  const alliance = await prisma.alliance.findUnique({ where: { id: String(req.params.id) } });
  if (!alliance) return err(res, 404, "Alliance introuvable");
  if (!(alliance as { recruiting?: boolean }).recruiting) return err(res, 409, `${alliance.name} ne recrute pas en ce moment`);
  if ((await roomFor(alliance.id, company.id)) <= 0) return err(res, 409, `${alliance.name} est complète`);
  const message = String(req.body?.message ?? "").replace(/\s+/g, " ").trim();
  if (message.length > APPLY_MESSAGE_MAX) return err(res, 400, `${APPLY_MESSAGE_MAX} caractères au plus`);
  const existing = await prisma.allianceApplication.findUnique({ where: { allianceId_companyId: { allianceId: alliance.id, companyId: company.id } } });
  if (existing) {
    await prisma.allianceApplication.update({ where: { id: existing.id }, data: { message } });
    return res.json({ ok: true, updated: true });
  }
  const pending = await prisma.allianceApplication.count({ where: { companyId: company.id } });
  if (pending >= APPLY_MAX_PENDING) return err(res, 409, `${APPLY_MAX_PENDING} candidatures en attente au plus. Retirez-en une d'abord.`);
  await prisma.allianceApplication.create({ data: { allianceId: alliance.id, companyId: company.id, message } });
  const { sendToCompany } = await import("../services/push.service");
  await sendToCompany(alliance.founderId, { title: "Nouvelle candidature", body: `${company.name} veut rejoindre ${alliance.name}.`, url: "/dashboard", tag: "alliance" }).catch(() => {});
  res.json({ ok: true });
}

export async function withdrawApplication(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const app = await prisma.allianceApplication.findFirst({ where: { id: req.params.id, companyId: company.id } });
  if (!app) return err(res, 404, "Candidature introuvable");
  await prisma.allianceApplication.delete({ where: { id: app.id } });
  res.json({ ok: true });
}

export async function answerApplication(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const alliance = await allianceOfCompany(company.id);
  if (!alliance || alliance.founderId !== company.id) return err(res, 403, "Seul le fondateur répond aux candidatures");
  const app = await prisma.allianceApplication.findFirst({ where: { id: req.params.id, allianceId: alliance.id } });
  if (!app) return err(res, 404, "Candidature introuvable, peut-être retirée");
  const applicant = await prisma.company.findUnique({ where: { id: app.companyId }, select: { id: true, name: true } });
  const { sendToCompany } = await import("../services/push.service");
  if (req.body?.accept !== true) {
    await prisma.allianceApplication.delete({ where: { id: app.id } });
    if (applicant) await sendToCompany(applicant.id, { title: "Candidature refusée", body: `${alliance.name} n'a pas retenu votre candidature.`, url: "/dashboard", tag: "alliance" }).catch(() => {});
    return res.json({ ok: true });
  }
  if (!applicant) {
    await prisma.allianceApplication.delete({ where: { id: app.id } });
    return err(res, 404, "Cette compagnie n'existe plus");
  }
  if (await prisma.allianceMember.findUnique({ where: { companyId: applicant.id } })) {
    await prisma.allianceApplication.delete({ where: { id: app.id } });
    return err(res, 409, `${applicant.name} a déjà rejoint une autre alliance`);
  }
  if ((await roomFor(alliance.id, applicant.id)) <= 0) return err(res, 409, `Votre alliance est complète (${ALLIANCE_MAX} compagnies, invitations comprises)`);
  await prisma.$transaction([
    prisma.allianceMember.create({ data: { allianceId: alliance.id, companyId: applicant.id, viaApplication: true } }),
    prisma.allianceApplication.deleteMany({ where: { companyId: applicant.id } }),
    prisma.allianceInvite.deleteMany({ where: { companyId: applicant.id } }),
  ]);
  invalidateAlliances();
  await sendToCompany(applicant.id, { title: "Candidature acceptée", body: `Bienvenue dans ${alliance.name} !`, url: "/dashboard", tag: "alliance" }).catch(() => {});
  res.json({ ok: true, name: applicant.name });
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

/* 2.1 : un membre (pas forcément le fondateur) qui possède le coffret
   d'alliance pose la livrée commune pour toute l'alliance. */
export async function setAllianceLivery(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const alliance = await allianceOfCompany(company.id);
  if (!alliance) return err(res, 409, "Vous n'avez pas d'alliance");
  const { unlockedFor } = await import("../services/shop.service");
  const u = await unlockedFor(company.id);
  const livery = req.body?.livery === null ? null : String(req.body?.livery ?? "").toLowerCase();
  if (livery !== null && !u.allianceLiveries.has(livery)) return err(res, 403, "Le coffret d'alliance se trouve en boutique");
  if (livery === null && alliance.founderId !== company.id) return err(res, 403, "Seul le fondateur retire la livrée commune");
  await prisma.alliance.update({ where: { id: alliance.id }, data: { livery } });
  res.json({ ok: true, livery });
}

/* 2.1 : le Musée de la compagnie — les épaves restaurées, sous les
   projecteurs. On visite le sien, ou celui d'un allié. */
export async function getMuseum(req: AuthRequest, res: Response) {
  const company = await myCompany(req);
  if (!company) return err(res, 404, "Créez d'abord votre compagnie");
  const target = req.params.companyId ? String(req.params.companyId) : company.id;
  if (target !== company.id) {
    const mine = await allianceOfCompany(company.id);
    const theirs = await allianceOfCompany(target);
    if (!mine || !theirs || mine.id !== theirs.id) return err(res, 403, "On visite le musée de ses alliés seulement");
  }
  const { unlockedFor } = await import("../services/shop.service");
  const u = await unlockedFor(target);
  const owner = await prisma.company.findUnique({ where: { id: target }, select: { id: true, name: true, liveryColor: true } });
  const wrecks = (await prisma.wreck.findMany({ where: { companyId: target, trainId: { not: null } }, orderBy: { completedAt: "asc" } })) as any[];
  const trains = (await prisma.train.findMany({ where: { id: { in: wrecks.map((w) => w.trainId) } }, select: { id: true, name: true, plateStyle: true, wear: true } })) as any[];
  res.json({
    open: u.museum,
    owner,
    pieces: wrecks.map((w) => ({
      id: w.id,
      kind: w.kind,
      serial: w.serial,
      year: w.year,
      station: w.station,
      restoredAt: w.completedAt,
      train: trains.find((t) => t.id === w.trainId) ?? null,
    })),
  });
}
