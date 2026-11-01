import { prisma } from "../prisma";
import { REGIONS } from "./regions.service";
import { stationSize } from "./station.service";
import { ownedDlcs, DLCS } from "./dlc.service";

/* ============================================================
   2.5 : les campagnes régionales.

   Après les Premiers pas, un nouveau venu ne savait pas quoi viser. Une
   campagne lui donne un fil : huit étapes dans une région, de la première
   gare desservie à la région entière, chacune avec sa prime, et un titre
   « Compagnie de … » à la fin.

   Les étapes sont les mêmes partout (servir, relier, faire rouler, livrer,
   s'étendre, électrifier, posséder une gare, tout desservir), habillées aux
   gares de la région. Une seule campagne active à la fois : en changer met
   l'autre en pause, sans rien perdre.

   Les étapes « de stock » (gares desservies, rames en service…) se lisent
   dans l'état du jeu ; celles qui comptent (livraisons, trajets) partent du
   début de l'étape, pour qu'un vétéran ne valide pas tout d'un coup.
   ============================================================ */

export const CAMPAIGN_REWARDS = [150, 250, 350, 450, 600, 800, 1000, 1500];
const FREIGHT_TARGET = 3;
const TRIPS_TARGET = 100;

// la Corse s'ouvre avec son extension ; Paris (une seule gare) et l'étranger n'ont pas de campagne
const SKIP = new Set(["idf", "etranger"]);

/* « de Bretagne », « du Grand Est », « des Hauts-de-France », « d'Occitanie » */
const OF: Record<string, string> = {
  hdf: "des Hauts-de-France",
  normandie: "de Normandie",
  "grand-est": "du Grand Est",
  bretagne: "de Bretagne",
  pdl: "des Pays de la Loire",
  cvl: "du Centre-Val de Loire",
  bfc: "de Bourgogne-Franche-Comté",
  "nouvelle-aquitaine": "de Nouvelle-Aquitaine",
  occitanie: "d'Occitanie",
  ara: "d'Auvergne-Rhône-Alpes",
  paca: "de Provence",
  corse: "de Corse",
};

/* le mot d'accueil de chaque campagne */
const INTRO: Record<string, string> = {
  hdf: "Le Nord a vu naître le chemin de fer français, et Lille attend toujours une compagnie à sa mesure.",
  normandie: "Du port du Havre aux plages de Caen, la Normandie veut ses trains de marée et de marchandises.",
  "grand-est": "Six villes, deux frontières et des marchés de Noël : le Grand Est est un réseau à lui seul.",
  bretagne: "La Bretagne veut son train jusqu'au bout de la terre. Rennes est la porte, Brest est le défi.",
  pdl: "Nantes, Angers, Le Mans : la Loire relie l'Atlantique au reste du pays. À vous d'en faire une ligne.",
  cvl: "Les châteaux de la Loire attirent le monde, et Orléans regarde vers Paris. Le Centre attend sa compagnie.",
  bfc: "Entre les vignes de Dijon et les horloges de Besançon, la Bourgogne cherche qui la desservira.",
  "nouvelle-aquitaine": "La plus grande région de France : de Bordeaux aux Pyrénées, de l'océan au Limousin.",
  occitanie: "Toulouse la rose, Montpellier la vive, Perpignan la catalane : l'Occitanie est immense et pressée.",
  ara: "Lyon, ses montagnes et ses vallées industrielles : la région qui fait rouler le plus de marchandises.",
  paca: "De Marseille à Nice, la Côte veut ses trains bondés l'été, et les Alpes du Sud leurs voies de montagne.",
  corse: "Une île, une voie étroite et le Trinichellu : la Corse se mérite, viaduc après viaduc.",
};

export const campaignTitle = (region: string) => `Compagnie ${OF[region] ?? region}`;

export type StepKind = "SERVE" | "LINK" | "TRAINS" | "FREIGHT" | "SPREAD" | "ELECTRIC" | "STATION" | "ALL";
export interface CampaignStep {
  kind: StepKind;
  title: string;
  text: string;
  target: number;
  reward: number;
}

/* Les gares de la campagne : celles de la région, sans les gares d'extension
   de montagne (tout le monde n'en a pas l'accès) ; la Corse, elle, est toute
   entière une extension. Les plus grandes en tête. */
function stationsOf(region: string): string[] {
  const r = REGIONS.find((x) => x.id === region);
  if (!r) return [];
  const mountain = DLCS.find((d) => d.id === "dlc-montagne")?.stations ?? [];
  return r.stations.filter((s) => region === "corse" || !mountain.includes(s)).sort((a, b) => stationSize(b) - stationSize(a));
}

export function campaignSteps(region: string): CampaignStep[] {
  const S = stationsOf(region);
  const of = OF[region] ?? "";
  const [a, b] = S;
  const spread = Math.min(S.length, Math.max(2, Math.ceil(S.length * 0.6)));
  const steps: Omit<CampaignStep, "reward">[] = [
    { kind: "SERVE", title: "Premier quai", text: `Desservir une gare ${of} (un arrêt intermédiaire compte).`, target: 1 },
    { kind: "LINK", title: `${a} – ${b}`, text: `Ouvrir une ligne qui passe par ${a} et par ${b}.`, target: 1 },
    { kind: "TRAINS", title: "Du monde sur les quais", text: `Faire rouler 2 rames sur des lignes qui passent dans la région.`, target: 2 },
    { kind: "FREIGHT", title: "Les marchandises suivent", text: `Livrer ${FREIGHT_TARGET} cargaisons au départ ou à destination d'une gare ${of}.`, target: FREIGHT_TARGET },
    { kind: "SPREAD", title: "Le réseau s'étend", text: `Desservir ${spread} gares ${of}.`, target: spread },
    { kind: "ELECTRIC", title: "Sous caténaire", text: `Électrifier une ligne qui passe dans la région.`, target: 1 },
    { kind: "STATION", title: "Une gare à soi", text: `Posséder une gare ${of}.`, target: 1 },
    { kind: "ALL", title: `${REGIONS.find((r) => r.id === region)?.name ?? region} au complet`, text: `Desservir toutes les gares ${of} (${S.join(", ")}) et encaisser ${TRIPS_TARGET} trajets sur ses lignes.`, target: S.length + TRIPS_TARGET },
  ];
  return steps.map((s, i) => ({ ...s, reward: CAMPAIGN_REWARDS[i] }));
}

export async function campaignRegions(companyId: string) {
  const dlcs = await ownedDlcs(companyId).catch(() => new Set<string>());
  return REGIONS.filter((r) => !SKIP.has(r.id) && (!r.dlc || dlcs.has(r.dlc)) && stationsOf(r.id).length >= 2);
}

/* ---------------- la progression d'une étape ---------------- */

type LineRow = { id: string; departureStation: string; arrivalStation: string; stops: string[]; electrified: boolean };
const routeOf = (l: LineRow) => [l.departureStation, ...(l.stops ?? []), l.arrivalStation];

export async function stepProgress(companyId: string, region: string, stepIndex: number, since: Date): Promise<{ current: number; target: number; detail?: string }> {
  const step = campaignSteps(region)[stepIndex];
  if (!step) return { current: 0, target: 0 };
  const S = stationsOf(region);
  const inRegion = new Set(S);
  const lines = (await prisma.line.findMany({
    where: { companyId },
    select: { id: true, departureStation: true, arrivalStation: true, stops: true, electrified: true },
  })) as LineRow[];
  const regionLines = lines.filter((l) => routeOf(l).some((s) => inRegion.has(s)));
  const served = new Set(lines.flatMap(routeOf).filter((s) => inRegion.has(s)));
  const cap = (n: number) => ({ current: Math.min(n, step.target), target: step.target });

  switch (step.kind) {
    case "SERVE":
    case "SPREAD":
      return cap(served.size);
    case "LINK": {
      const [a, b] = S;
      return cap(lines.some((l) => routeOf(l).includes(a) && routeOf(l).includes(b)) ? 1 : 0);
    }
    case "TRAINS":
      return cap(
        regionLines.length
          ? await prisma.train.count({ where: { companyId, status: "EN_ROUTE", lineId: { in: regionLines.map((l) => l.id) } } })
          : 0
      );
    case "FREIGHT":
      return cap(
        await prisma.contract.count({
          where: { companyId, status: "LIVREE", acceptedAt: { gte: since }, OR: [{ originStation: { in: S } }, { destinationStation: { in: S } }] },
        })
      );
    case "ELECTRIC":
      return cap(regionLines.some((l) => l.electrified) ? 1 : 0);
    case "STATION":
      return cap(await prisma.stationOwnership.count({ where: { companyId, station: { in: S } } }));
    case "ALL": {
      const trips = regionLines.length
        ? await prisma.transaction.count({ where: { companyId, type: "REVENU_LIGNE", createdAt: { gte: since }, lineId: { in: regionLines.map((l) => l.id) } } })
        : 0;
      // les deux moitiés comptent séparément : toutes les gares, et les trajets
      return { ...cap(served.size + Math.min(trips, TRIPS_TARGET)), detail: `${served.size} / ${S.length} gares · ${Math.min(trips, TRIPS_TARGET)} / ${TRIPS_TARGET} trajets` };
    }
  }
}

/* ---------------- ce que voit le joueur ---------------- */

export async function campaignView(companyId: string) {
  const [regions, rows] = await Promise.all([
    campaignRegions(companyId),
    prisma.regionCampaign.findMany({ where: { companyId } }) as Promise<
      { region: string; step: number; active: boolean; startedAt: Date; stepStartedAt: Date; completedAt: Date | null }[]
    >,
  ]);
  const byRegion = new Map(rows.map((r) => [r.region, r]));
  const active = rows.find((r) => r.active && !r.completedAt) ?? null;
  let current = null;
  if (active) {
    const steps = campaignSteps(active.region);
    const p = await stepProgress(companyId, active.region, active.step, active.stepStartedAt);
    current = {
      region: active.region,
      name: REGIONS.find((r) => r.id === active.region)?.name ?? active.region,
      intro: INTRO[active.region] ?? "",
      title: campaignTitle(active.region),
      step: active.step,
      progress: p,
      ready: p.current >= p.target,
      steps: steps.map((s, i) => ({ title: s.title, text: s.text, reward: s.reward, done: i < active.step })),
    };
  }
  return {
    current,
    total: CAMPAIGN_REWARDS.reduce((n, r) => n + r, 0),
    regions: regions.map((r) => {
      const row = byRegion.get(r.id);
      return {
        id: r.id,
        name: r.name,
        intro: INTRO[r.id] ?? "",
        title: campaignTitle(r.id),
        stations: stationsOf(r.id),
        steps: campaignSteps(r.id).length,
        step: row?.step ?? 0,
        started: Boolean(row),
        done: Boolean(row?.completedAt),
        active: Boolean(row?.active && !row.completedAt),
      };
    }),
  };
}

/* Commencer (ou reprendre) une campagne : l'autre campagne active passe en pause. */
export async function startCampaign(companyId: string, region: string) {
  const allowed = await campaignRegions(companyId);
  if (!allowed.some((r) => r.id === region)) return { ok: false as const, error: "Campagne indisponible" };
  const existing = (await prisma.regionCampaign.findUnique({ where: { companyId_region: { companyId, region } } })) as { completedAt: Date | null } | null;
  if (existing?.completedAt) return { ok: false as const, error: "Campagne déjà terminée" };
  await prisma.$transaction([
    prisma.regionCampaign.updateMany({ where: { companyId, active: true, NOT: { region } }, data: { active: false } }),
    existing
      ? prisma.regionCampaign.update({ where: { companyId_region: { companyId, region } }, data: { active: true, stepStartedAt: new Date() } })
      : prisma.regionCampaign.create({ data: { companyId, region } }),
  ]);
  return { ok: true as const };
}

/* Valider l'étape en cours : vérifiée ici, jamais sur la parole de l'interface. */
export async function claimCampaignStep(companyId: string) {
  const row = (await prisma.regionCampaign.findFirst({ where: { companyId, active: true, completedAt: null } })) as
    | { id: string; region: string; step: number; stepStartedAt: Date }
    | null;
  if (!row) return { ok: false as const, error: "Aucune campagne en cours" };
  const steps = campaignSteps(row.region);
  const step = steps[row.step];
  if (!step) return { ok: false as const, error: "Campagne terminée" };
  const p = await stepProgress(companyId, row.region, row.step, row.stepStartedAt);
  if (p.current < p.target) return { ok: false as const, error: `Pas encore : ${p.current} / ${p.target}` };
  const last = row.step + 1 >= steps.length;
  const region = REGIONS.find((r) => r.id === row.region)?.name ?? row.region;
  // l'étape ne passe qu'une fois, même si deux clics arrivent ensemble
  const moved = await prisma.regionCampaign.updateMany({
    where: { id: row.id, step: row.step },
    data: { step: row.step + 1, stepStartedAt: new Date(), ...(last ? { completedAt: new Date(), active: false } : {}) },
  });
  if (!moved.count) return { ok: false as const, error: "Déjà validée" };
  await prisma.$transaction([
    prisma.company.update({ where: { id: companyId }, data: { balance: { increment: step.reward } } }),
    prisma.transaction.create({ data: { companyId, type: "CAMPAGNE", amount: step.reward, description: `Campagne ${region} : ${step.title}` } }),
  ]);
  return { ok: true as const, reward: step.reward, finished: last, title: last ? campaignTitle(row.region) : null };
}

/* Les titres gagnés (pour la liste des titres débloqués). */
export async function campaignTitles(companyId: string): Promise<string[]> {
  const done = (await prisma.regionCampaign.findMany({ where: { companyId, completedAt: { not: null } }, select: { region: true } }).catch(() => [])) as { region: string }[];
  return done.map((d) => campaignTitle(d.region));
}
