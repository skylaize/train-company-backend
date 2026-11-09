import { prisma } from "../prisma";
import { Prisma } from "@prisma/client";
import { chunk, row } from "./batch.service";

/* ============================================================
   2.7 : la quête de fin de saison.

   Elle s'ouvre à la moitié de la saison. Une suite de paliers, l'un après
   l'autre : seul le palier en cours avance. Au dernier palier franchi, la
   récompense : une pour tout le monde, une de plus pour qui a le pass.

   Les événements viennent de la simulation (comme les objectifs de la
   semaine). L'état de tout le monde est gardé en mémoire pour la saison
   en cours, et écrit en une requête groupée à chaque tour.
   ============================================================ */

export type QuestKind = "THERMAL_TRIPS" | "FREIGHT" | "REVISE" | "FULL_TRIPS" | "POINTS" | "TRIPS";

export type QuestReward =
  | { type: "HABILLAGE"; id: string; label: string }
  | { type: "TITRE"; title: string; label: string }
  | { type: "GARE"; id: string; label: string };

export interface Quest {
  name: string;
  intro: string;
  steps: { kind: QuestKind; target: number; label: string }[];
  rewards: { all: QuestReward[]; pass: QuestReward[] };
}

/* Une quête par thème de saison. Les thèmes sans quête n'en ont pas. */
export const QUESTS: Record<string, Quest> = {
  vieux: {
    name: "Le vieux matériel reprend du service",
    intro: "Cinq paliers à franchir avant la fin de la saison, dans l'ordre. Au bout, le titre « Héros de l'électrification » pour tout le monde, et la BB 69200 pour qui a le pass.",
    steps: [
      { kind: "THERMAL_TRIPS", target: 60, label: "Faire 60 trajets avec une rame diesel ou vapeur" },
      { kind: "FREIGHT", target: 10, label: "Livrer 10 contrats de fret" },
      { kind: "REVISE", target: 4, label: "Réviser 4 rames avant la panne" },
      { kind: "FULL_TRIPS", target: 80, label: "Faire 80 trajets remplis à 80 %" },
      { kind: "POINTS", target: 1500, label: "Gagner 1 500 points de saison" },
    ],
    rewards: {
      all: [{ type: "TITRE", title: "Héros de l'électrification", label: "Titre « Héros de l'électrification »" }],
      pass: [{ type: "HABILLAGE", id: "bb69200", label: "Habillage « BB 69200 » (fret rapide)" }],
    },
  },
};

export const QUEST_OPENS_AFTER_DAYS = 14;

export function questOpen(season: { startsAt: Date; endsAt: Date }, now = new Date()) {
  return now.getTime() >= season.startsAt.getTime() + QUEST_OPENS_AFTER_DAYS * 86_400_000 && now < season.endsAt;
}

/* ---------------- événements ---------------- */

const pending = new Map<string, number>(); // "companyId|kind" -> quantité

export function questEvent(companyId: string, kind: QuestKind, amount = 1) {
  if (amount <= 0) return;
  const key = `${companyId}|${kind}`;
  pending.set(key, (pending.get(key) ?? 0) + amount);
}

type State = { step: number; progress: number; doneAt: Date | null; dirty: boolean };
let cacheSeason: string | null = null;
let states = new Map<string, State>();

async function load(seasonId: string) {
  if (cacheSeason === seasonId) return;
  const rows = (await prisma.seasonQuest.findMany({ where: { seasonId } })) as { companyId: string; step: number; progress: number; doneAt: Date | null }[];
  states = new Map(rows.map((r) => [r.companyId, { step: r.step, progress: r.progress, doneAt: r.doneAt, dirty: false }]));
  cacheSeason = seasonId;
}

/* Appelé par flushSeason, avec la saison et la clé de son thème. Renvoie
   les compagnies qui viennent de finir la quête (pour les prévenir). */
export async function flushQuest(season: { id: string; startsAt: Date; endsAt: Date }, themeKey: string, now = new Date()) {
  const quest = QUESTS[themeKey];
  const events = new Map(pending);
  pending.clear();
  if (!quest || !questOpen(season, now) || events.size === 0) return [] as string[];
  await load(season.id);
  const finished: string[] = [];
  for (const [key, amount] of events) {
    const [companyId, kind] = key.split("|");
    const st = states.get(companyId) ?? { step: 0, progress: 0, doneAt: null, dirty: false };
    if (st.doneAt) continue;
    const step = quest.steps[st.step];
    if (!step || step.kind !== kind) continue;
    st.progress = Math.min(step.target, st.progress + amount);
    if (st.progress >= step.target) {
      st.step++;
      st.progress = 0;
      if (st.step >= quest.steps.length) {
        st.doneAt = now;
        finished.push(companyId);
      }
    }
    st.dirty = true;
    states.set(companyId, st);
  }
  const dirty = [...states.entries()].filter(([, s]) => s.dirty);
  for (const part of chunk(dirty, 500)) {
    await prisma.$executeRaw`
      INSERT INTO "SeasonQuest" ("seasonId", "companyId", "step", "progress", "doneAt")
      SELECT ${season.id}, v.company::text, v.step::int, v.progress::int, NULLIF(v.done::text, '')::timestamp
      FROM (VALUES ${Prisma.join(part.map(([id, s]) => row([id, s.step, s.progress, s.doneAt ? s.doneAt.toISOString() : ""])))}) AS v(company, step, progress, done)
      ON CONFLICT ("seasonId", "companyId") DO UPDATE SET "step" = EXCLUDED."step", "progress" = EXCLUDED."progress", "doneAt" = EXCLUDED."doneAt"`;
    for (const [, s] of part) s.dirty = false;
  }
  return finished;
}

/* La quête d'une compagnie, pour la page de la saison. */
export async function questView(season: { id: string; number: number; startsAt: Date; endsAt: Date }, themeKey: string, companyId: string, hasPass: boolean) {
  const quest = QUESTS[themeKey];
  if (!quest) return null;
  const opensAt = new Date(season.startsAt.getTime() + QUEST_OPENS_AFTER_DAYS * 86_400_000);
  const row = (await prisma.seasonQuest.findUnique({ where: { seasonId_companyId: { seasonId: season.id, companyId } } })) as { step: number; progress: number; doneAt: Date | null } | null;
  // ce qui n'est pas encore écrit en base (le tour en cours) est dans le cache
  const live = cacheSeason === season.id ? states.get(companyId) : undefined;
  const st = live ?? row ?? { step: 0, progress: 0, doneAt: null };
  return {
    name: quest.name,
    intro: quest.intro,
    open: questOpen(season),
    opensAt,
    endsAt: season.endsAt,
    step: st.step,
    progress: st.progress,
    doneAt: st.doneAt,
    steps: quest.steps.map((s) => ({ label: s.label, target: s.target })),
    rewards: { all: quest.rewards.all, pass: quest.rewards.pass },
    hasPass,
  };
}

/* Ce que les quêtes finies ont débloqué, toutes saisons confondues. */
export async function questUnlocks(companyId: string, themeOfSeason: (s: { name: string }) => string) {
  const out = { cabSkins: [] as string[], titles: [] as string[], stationSkins: [] as string[] };
  const done = (await prisma.seasonQuest.findMany({ where: { companyId, doneAt: { not: null } }, select: { seasonId: true } })) as { seasonId: string }[];
  for (const d of done) {
    const season = (await prisma.season.findUnique({ where: { id: d.seasonId }, select: { number: true, name: true } })) as { number: number; name: string } | null;
    if (!season) continue;
    const quest = QUESTS[themeOfSeason(season)];
    if (!quest) continue;
    const pass = await prisma.shopPurchase.findUnique({ where: { companyId_itemId: { companyId, itemId: `pass-s${season.number}` } } });
    for (const r of [...quest.rewards.all, ...(pass ? quest.rewards.pass : [])]) {
      if (r.type === "HABILLAGE") out.cabSkins.push(r.id);
      if (r.type === "TITRE") out.titles.push(r.title);
      if (r.type === "GARE") out.stationSkins.push(r.id);
    }
  }
  return out;
}
