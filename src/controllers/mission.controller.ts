import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import {
  CLIENTS,
  levelFromReputation,
  nextLevel,
  REPUTATION_MAX,
  FAILURE_PENALTY,
} from "../services/client.service";
import { refreshMissionsFor, deadlineHoursFor } from "../services/mission.service";
import { buildLeaderRows } from "../services/leaderboard.service";

async function companyOf(req: AuthRequest) {
  return prisma.company.findUnique({
    where: { ownerId: req.userId as string },
    select: { id: true, isPremium: true },
  });
}

async function gradeOf(companyId: string) {
  const rows = await buildLeaderRows();
  return rows.find((r) => r.id === companyId)?.gradeId ?? 0;
}

export async function getMyClients(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const gradeId = await gradeOf(company.id);
  await refreshMissionsFor(company.id, gradeId, company.isPremium);

  const [relations, missions] = await Promise.all([
    prisma.clientRelation.findMany({ where: { companyId: company.id } }),
    prisma.mission.findMany({
      where: { companyId: company.id, status: { in: ["PROPOSEE", "ACCEPTEE", "ECHOUEE"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  type Rel = { clientId: string; reputation: number };
  type Mis = {
    id: string; clientId: string; cargoType: string; target: number; progress: number;
    reward: number; repReward: number; status: string; offerUntil: Date; dueAt: Date | null; createdAt: Date;
  };

  const repByClient = new Map<string, number>((relations as Rel[]).map((r) => [r.clientId, r.reputation]));
  const list = missions as Mis[];

  const payload = CLIENTS.map((client) => {
    const locked = client.minGradeId > gradeId;
    const reputation = repByClient.get(client.id) ?? 0;
    const lvl = levelFromReputation(reputation);
    const next = nextLevel(reputation);

    /* Tous les ordres ouverts du chargeur — un abonné en a deux. Si aucun
       n'est ouvert, on montre le dernier échec : le joueur doit comprendre
       pourquoi sa réputation a bougé plutôt que de le découvrir sans
       explication. */
    const open = list.filter((m) => m.clientId === client.id && m.status !== "ECHOUEE");
    const current = open.length > 0 ? open : list.filter((m) => m.clientId === client.id).slice(0, 1);

    return {
      id: client.id,
      name: client.name,
      sector: client.sector,
      city: client.city,
      cargoTypes: client.cargoTypes,
      color: client.color,
      colorPaper: client.colorPaper,
      locked,
      lockReason: locked
        ? `Ce chargeur ne traite qu'avec les compagnies ayant atteint un grade supérieur.`
        : null,
      reputation,
      reputationMax: REPUTATION_MAX,
      levelName: lvl.name,
      bonus: Math.round(lvl.bonus * 100),
      nextLevelAt: next ? next.from : null,
      nextLevelName: next ? next.name : null,
      missions: locked
        ? []
        : current.map((m) => ({
            id: m.id,
            cargoType: m.cargoType,
            target: m.target,
            progress: m.progress,
            reward: m.reward,
            repReward: m.repReward,
            status: m.status,
            offerUntil: m.offerUntil,
            dueAt: m.dueAt,
            // référence lisible, dans le vocabulaire du bordereau
            ref: `${client.id.slice(0, 2)}-${m.id.slice(0, 4).toUpperCase()}`,
          })),
    };
  });

  return res.json({ clients: payload, failurePenalty: FAILURE_PENALTY });
}

export async function acceptMission(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const mission = await prisma.mission.findFirst({
    where: { id: req.params.id, companyId: company.id, status: "PROPOSEE" },
  });
  if (!mission) return res.status(404).json({ error: "Cet ordre n'est plus disponible" });

  if (new Date(mission.offerUntil).getTime() < Date.now()) {
    return res.status(400).json({ error: "Le délai pour accepter cet ordre est dépassé" });
  }

  const updated = await prisma.mission.update({
    where: { id: mission.id },
    data: {
      status: "ACCEPTEE",
      // l'échéance ne court qu'à partir de l'acceptation
      dueAt: new Date(Date.now() + deadlineHoursFor(mission.target) * 3600_000),
    },
  });

  return res.json({ id: updated.id, status: updated.status, dueAt: updated.dueAt });
}

export async function declineMission(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });

  const mission = await prisma.mission.findFirst({
    where: { id: req.params.id, companyId: company.id, status: "PROPOSEE" },
  });
  if (!mission) return res.status(404).json({ error: "Cet ordre n'est plus disponible" });

  // refuser ne coûte pas de réputation : seul un engagement non tenu en coûte
  await prisma.mission.update({ where: { id: mission.id }, data: { status: "ECHOUEE" } });
  return res.json({ ok: true });
}
