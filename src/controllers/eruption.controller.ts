import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { prisma } from "../prisma";
import { contribute, eruptionConfig, eruptionSummary, ERUPTION_REGIONS, ICON_SHARE } from "../services/eruption.service";
import { botEnabled, BRAND_COLOR, esc, postOnce } from "../services/discord.service";

/* 2.7 : l'éruption solaire, côté joueur. */

// la page se recharge souvent : le résumé commun est gardé quelques secondes
let shared: { at: number; data: Awaited<ReturnType<typeof eruptionSummary>> } | null = null;
const TTL = 15_000;

async function companyOf(req: AuthRequest) {
  return (await prisma.company.findUnique({ where: { ownerId: req.userId as string }, select: { id: true, name: true, voltPoints: true } })) as { id: string; name: string; voltPoints: number } | null;
}

export async function getEruption(req: AuthRequest, res: Response) {
  if (!eruptionConfig()) return res.json({ eruption: null });
  const company = await companyOf(req);
  if (!shared || Date.now() - shared.at > TTL) shared = { at: Date.now(), data: await eruptionSummary(null) };
  const data = shared.data;
  if (!data) return res.json({ eruption: null });
  // ce qui est propre au joueur : ses points, sa part de chaque sous-station
  const mine = company ? ((await prisma.subStationGift.findMany({ where: { companyId: company.id }, select: { region: true, points: true } })) as { region: string; points: number }[]) : [];
  const myBy = new Map(mine.map((g) => [g.region, g.points]));
  res.json({
    eruption: {
      ...data,
      points: company?.voltPoints ?? 0,
      regions: data.regions.map((r) => ({
        ...r,
        myPoints: myBy.get(r.id) ?? 0,
        contributors: r.contributors.map((c) => ({ ...c, me: c.companyId === company?.id })),
      })),
    },
  });
}

export async function repairSubStation(req: AuthRequest, res: Response) {
  const company = await companyOf(req);
  if (!company) return res.status(404).json({ error: "Créez d'abord votre compagnie" });
  const region = String(req.params.region ?? "");
  if (!ERUPTION_REGIONS.some((r) => r.id === region)) return res.status(404).json({ error: "Sous-station inconnue" });
  const r = await contribute(company.id, region, Number(req.body?.points)).catch((err) => {
    console.error("[éruption] réparation :", (err as Error).message);
    return { error: "Un autre joueur vient de donner en même temps, réessayez" };
  });
  if ("error" in r) return res.status(400).json(r);
  shared = null;
  const name = ERUPTION_REGIONS.find((x) => x.id === region)!.name;
  if (r.repaired && botEnabled()) {
    void postOnce(`eruption:reparee:${region}`, "ENERGIE", [
      {
        embeds: [
          {
            color: BRAND_COLOR,
            title: `⚡ Courant rétabli : ${name}`,
            description: `La sous-station de ${name} est réparée. Dernier point apporté par **${esc(company.name)}**. Les rames électriques de la région repartent.`,
          },
        ],
        allowed_mentions: { parse: [] },
      },
    ]).catch(() => undefined);
  }
  const share = r.cost ? (await prisma.subStationGift.findUnique({ where: { region_companyId: { region, companyId: company.id } } }))?.points ?? 0 : 0;
  res.json({ ...r, myPoints: share, icon: share >= Math.ceil(r.cost * ICON_SHARE) });
}
