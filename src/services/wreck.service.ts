import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { STATIONS } from "./geography.service";
import { INTERNATIONAL_STATIONS } from "./international.service";
import { MOUNTAIN_STATIONS } from "./dlc.service";
import { ORGANS, Organ, PARTS, readStock, takeFromStock, freshBias } from "./workshop.service";
import { sendToCompany } from "./push.service";

/* ============================================================
   2.0 : les épaves. De vieilles rames oubliées apparaissent près des gares.
   La première compagnie qui les rachète les ramène au dépôt (une place y
   est prise), puis les restaure organe par organe avec ses pièces. Remise
   en service, l'épave devient une rame de collection : numéro de série,
   histoire, livrée d'époque, et un billet plus cher (le prestige), au prix
   d'une usure un peu plus forte.
   ============================================================ */

export type Rarity = "COMMUNE" | "RARE" | "LEGENDAIRE";

export interface WreckKind {
  id: string;
  label: string;
  rarity: Rarity;
  model: string; // ce que la rame vaut en service
  skin: string; // son allure (trainArt)
  livery: string; // sa livrée d'époque
  years: [number, number];
  serial: string;
  price: number;
  prestige: number; // multiplicateur du billet
  workMin: number; // minutes d'atelier pour un organe détruit à 100 %
}

export const WRECK_KINDS: Record<string, WreckKind> = {
  MICHELINE: { id: "MICHELINE", label: "Autorail Micheline", rarity: "COMMUNE", model: "STANDARD", skin: "micheline", livery: "#b8322a", years: [1932, 1953], serial: "ZZ", price: 250, prestige: 1.1, workMin: 15 },
  DUPLEX: { id: "DUPLEX", label: "Rame à deux niveaux", rarity: "COMMUNE", model: "STANDARD", skin: "duplex", livery: "#3c6e9e", years: [1975, 1990], serial: "VB2N", price: 250, prestige: 1.1, workMin: 15 },
  TRAIN_BLEU: { id: "TRAIN_BLEU", label: "Voitures-lits du Train bleu", rarity: "RARE", model: "COUCHETTES", skin: "train-bleu", livery: "#1d2f5c", years: [1922, 1938], serial: "WL", price: 650, prestige: 1.18, workMin: 30 },
  ORANGE: { id: "ORANGE", label: "Rame orange de 1981", rarity: "RARE", model: "EXPRESS", skin: "grande-vitesse", livery: "#e36a12", years: [1978, 1984], serial: "Rame n°", price: 650, prestige: 1.18, workMin: 30 },
  VAPEUR_141R: { id: "VAPEUR_141R", label: "Locomotive 141 R", rarity: "LEGENDAIRE", model: "STANDARD", skin: "vapeur", livery: "#1f1f1f", years: [1945, 1947], serial: "141 R", price: 1400, prestige: 1.3, workMin: 60 },
};

const RARITY_WEIGHT: [Rarity, number][] = [
  ["COMMUNE", 65],
  ["RARE", 28],
  ["LEGENDAIRE", 7],
];
// combien de temps une épave attend preneur
const LIFETIME_H: Record<Rarity, number> = { COMMUNE: 36, RARE: 24, LEGENDAIRE: 12 };
export const RARITY_LABEL: Record<Rarity, string> = { COMMUNE: "Commune", RARE: "Rare", LEGENDAIRE: "Légendaire" };

export const HERITAGE_WEAR = 1.2; // le vieux matériel s'use un peu plus vite
export const MAX_WRECKS_PER_COMPANY = 2; // épaves en restauration en même temps
const SPAWN_GAP_MIN = 45; // une découverte au plus toutes les 45 minutes

const PLACES = [
  "sur une voie de garage envahie par les ronces",
  "au fond d'un dépôt abandonné",
  "derrière une ancienne scierie",
  "sur un embranchement oublié",
  "sous un hangar effondré",
  "au bout d'une voie de carrière",
];

export interface Heritage {
  wreckId: string;
  kind: string;
  label: string;
  rarity: Rarity;
  serial: string;
  year: number;
  history: string;
  skin: string;
  livery: string;
  prestige: number;
  value: number; // tout ce qui a été investi : rachat et pièces
}

export function heritageOf(train: { heritage?: unknown }): Heritage | null {
  const h = train.heritage as Heritage | null | undefined;
  return h && typeof h === "object" && h.kind ? h : null;
}

/* pièces nécessaires pour un organe : une par tranche de 35 % de dégâts */
export function partsNeeded(damage: number) {
  return Math.max(1, Math.ceil(damage / 35));
}

export function workMinutes(kind: WreckKind, damage: number) {
  return Math.max(5, Math.round((kind.workMin * damage) / 100));
}

function pick<T>(list: T[], random: () => number) {
  return list[Math.floor(random() * list.length) % list.length];
}

export function rollRarity(random = Math.random): Rarity {
  const total = RARITY_WEIGHT.reduce((s, [, w]) => s + w, 0);
  let r = random() * total;
  for (const [k, w] of RARITY_WEIGHT) {
    if ((r -= w) < 0) return k;
  }
  return "COMMUNE";
}

export function draftWreck(station: string, now = new Date(), random = Math.random) {
  const rarity = rollRarity(random);
  const kind = pick(Object.values(WRECK_KINDS).filter((k) => k.rarity === rarity), random);
  const year = kind.years[0] + Math.floor(random() * (kind.years[1] - kind.years[0] + 1));
  const retired = Math.min(2015, year + 25 + Math.floor(random() * 20));
  const serial = `${kind.serial} ${String(100 + Math.floor(random() * 1900))}`;
  // une légendaire est en plus mauvais état : plus de pièces, plus d'atelier
  const base = rarity === "LEGENDAIRE" ? 55 : rarity === "RARE" ? 40 : 25;
  const damage = Object.fromEntries(ORGANS.map((o) => [o, Math.min(100, base + Math.floor(random() * (100 - base + 1)))])) as Record<Organ, number>;
  return {
    kind: kind.id,
    rarity,
    station,
    serial,
    year,
    retiredYear: retired,
    history: `Mise en service en ${year}, retirée en ${retired}, retrouvée ${pick(PLACES, random)} près de ${station}.`,
    damage: damage as unknown as Prisma.InputJsonValue,
    price: kind.price,
    discoveredAt: now,
    expiresAt: new Date(now.getTime() + LIFETIME_H[rarity] * 3_600_000),
  };
}

export function damageOf(w: { damage: unknown }) {
  const d = (w.damage ?? {}) as Record<string, number>;
  return Object.fromEntries(ORGANS.map((o) => [o, Math.max(0, Math.min(100, Number(d[o]) || 0))])) as Record<Organ, number>;
}

/* l'état d'avancement, vu de l'extérieur */
export function wreckView(w: {
  id: string; kind: string; rarity: string; station: string; serial: string; year: number; history: string; damage: unknown;
  restored: string[]; working: string | null; workUntil: Date | null; price: number; spent: number; expiresAt: Date; companyId: string | null; trainId: string | null;
}, stock?: Record<string, number>) {
  const kind = WRECK_KINDS[w.kind];
  const dmg = damageOf(w);
  const organs = ORGANS.map((o) => {
    const need = partsNeeded(dmg[o]);
    const have = stock ? Math.min(need, stock[o] ?? 0) : 0;
    return {
      organ: o,
      label: PARTS[o].label,
      damage: dmg[o],
      restored: w.restored.includes(o),
      working: w.working === o,
      partsNeeded: need,
      partLabel: need > 1 ? PARTS[o].plural : PARTS[o].part,
      fromStock: have,
      cost: (need - have) * PARTS[o].price,
      minutes: workMinutes(kind, dmg[o]) + (need > have ? PARTS[o].delayMin : 0),
    };
  });
  const done = w.restored.length;
  return {
    id: w.id,
    kind: w.kind,
    label: kind?.label ?? w.kind,
    rarity: w.rarity,
    rarityLabel: RARITY_LABEL[w.rarity as Rarity] ?? w.rarity,
    model: kind?.model,
    skin: kind?.skin,
    livery: kind?.livery,
    prestige: kind?.prestige,
    station: w.station,
    serial: w.serial,
    year: w.year,
    history: w.history,
    price: w.price,
    spent: w.spent,
    expiresAt: w.expiresAt,
    workUntil: w.workUntil,
    progress: Math.round((done / ORGANS.length) * 100),
    ready: done === ORGANS.length,
    organs,
    commissioned: Boolean(w.trainId),
  };
}

/* ---------- le passage régulier : découvertes, fins de chantier ---------- */

let lastRun = 0;
export async function runWrecks(now = new Date(), random = Math.random) {
  // fin d'un organe : le suivant peut commencer, le joueur est prévenu
  const finished = await prisma.wreck.findMany({ where: { working: { not: null }, workUntil: { lte: now } } });
  for (const w of finished) {
    const organ = w.working as Organ;
    const done = await prisma.wreck.updateMany({
      where: { id: w.id, working: organ, workUntil: { lte: now } },
      data: { working: null, workUntil: null, restored: { set: [...new Set([...w.restored, organ])] } },
    });
    if (done.count && w.companyId) {
      const left = ORGANS.length - new Set([...w.restored, organ]).size;
      const label = WRECK_KINDS[w.kind]?.label ?? "L'épave";
      void sendToCompany(w.companyId, {
        title: left ? `${label} : ${PARTS[organ].label.toLowerCase()} restaurés` : `${label} : restauration terminée`,
        body: left ? `Encore ${left} organe${left > 1 ? "s" : ""} avant la remise en service.` : "La rame attend sa remise en service au dépôt.",
        url: "/dashboard",
        tag: `epave-${w.id}`,
      });
    }
  }

  if (now.getTime() - lastRun < 5 * 60_000) return;
  lastRun = now.getTime();

  // les épaves que personne n'a rachetées repartent à la ferraille
  await prisma.wreck.deleteMany({ where: { companyId: null, expiresAt: { lte: now } } });

  const [open, last, active] = await Promise.all([
    prisma.wreck.findMany({ where: { companyId: null }, select: { station: true } }),
    prisma.wreck.findFirst({ orderBy: { discoveredAt: "desc" }, select: { discoveredAt: true } }),
    prisma.company.count({ where: { lastActiveAt: { gte: new Date(now.getTime() - 3 * 86_400_000) } } }).catch(() => 40),
  ]);
  const target = Math.min(6, 3 + Math.floor(active / 40));
  if (open.length >= target) return;
  if (last && now.getTime() - last.discoveredAt.getTime() < SPAWN_GAP_MIN * 60_000) return;

  const taken = new Set(open.map((w) => w.station));
  const candidates = STATIONS.filter((s) => !(s in INTERNATIONAL_STATIONS) && !MOUNTAIN_STATIONS.includes(s) && !taken.has(s));
  if (!candidates.length) return;
  await prisma.wreck.create({ data: draftWreck(pick(candidates, random), now, random) });
}

/* ---------- les actions du joueur ---------- */

type Result<T = unknown> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function depotUse(companyId: string) {
  const [trains, wrecks] = await Promise.all([
    prisma.train.count({ where: { companyId } }),
    prisma.wreck.count({ where: { companyId, trainId: null } }),
  ]);
  return trains + wrecks;
}

export async function buyWreck(companyId: string, wreckId: string, now = new Date()): Promise<Result> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, balance: true, maxTrains: true } });
  if (!company) return { ok: false, status: 404, error: "Compagnie introuvable" };
  const w = await prisma.wreck.findUnique({ where: { id: wreckId } });
  if (!w || w.expiresAt <= now) return { ok: false, status: 404, error: "Cette épave est partie à la ferraille" };
  if (w.companyId) return { ok: false, status: 409, error: w.companyId === companyId ? "Elle est déjà à vous" : "Une autre compagnie vient de la racheter" };
  const mine = await prisma.wreck.count({ where: { companyId, trainId: null } });
  if (mine >= MAX_WRECKS_PER_COMPANY) return { ok: false, status: 409, error: `Deux épaves en restauration au plus : remettez-en une en service d'abord` };
  if ((await depotUse(companyId)) >= company.maxTrains) return { ok: false, status: 403, error: "Votre dépôt est plein : l'épave y prend une place, comme une rame" };
  if (company.balance < w.price) return { ok: false, status: 409, error: `Trésorerie insuffisante (rachat : ${w.price} pièces)` };

  const label = WRECK_KINDS[w.kind]?.label ?? "une épave";
  try {
    await prisma.$transaction(async (tx) => {
      // la première compagnie l'emporte : la ligne n'est prise que si elle est encore libre
      const claimed = await tx.wreck.updateMany({ where: { id: w.id, companyId: null }, data: { companyId, claimedAt: now, spent: w.price } });
      if (!claimed.count) throw new Error("PRISE");
      const paid = await tx.company.updateMany({ where: { id: companyId, balance: { gte: w.price } }, data: { balance: { decrement: w.price } } });
      if (!paid.count) throw new Error("ARGENT");
      await tx.transaction.create({ data: { companyId, type: "ACHAT_TRAIN", amount: -w.price, description: `Rachat d'une épave : ${label} ${w.serial}` } });
    });
  } catch (e) {
    const m = (e as Error).message;
    if (m === "PRISE") return { ok: false, status: 409, error: "Une autre compagnie vient de la racheter" };
    if (m === "ARGENT") return { ok: false, status: 409, error: `Trésorerie insuffisante (rachat : ${w.price} pièces)` };
    throw e;
  }
  return { ok: true, data: { id: w.id } };
}

export async function restoreOrgan(companyId: string, wreckId: string, organ: string, now = new Date()): Promise<Result> {
  if (!ORGANS.includes(organ as Organ)) return { ok: false, status: 400, error: "Organe inconnu" };
  const o = organ as Organ;
  const w = await prisma.wreck.findFirst({ where: { id: wreckId, companyId, trainId: null } });
  if (!w) return { ok: false, status: 404, error: "Épave introuvable" };
  if (w.restored.includes(o)) return { ok: false, status: 409, error: "Cet organe est déjà restauré" };
  if (w.working) return { ok: false, status: 409, error: "L'atelier travaille déjà sur cette épave" };
  const kind = WRECK_KINDS[w.kind];
  const dmg = damageOf(w)[o];
  const need = partsNeeded(dmg);

  // on réserve l'atelier d'abord : un double clic ne lance pas deux chantiers
  const until = new Date(now.getTime() + workMinutes(kind, dmg) * 60_000);
  const lock = await prisma.wreck.updateMany({ where: { id: w.id, working: null }, data: { working: o, workUntil: until } });
  if (!lock.count) return { ok: false, status: 409, error: "L'atelier travaille déjà sur cette épave" };

  // les pièces en stock d'abord, le reste est commandé
  let fromStock = 0;
  for (let i = 0; i < need; i++) {
    if (await takeFromStock(companyId, o)) fromStock++;
    else break;
  }
  const missing = need - fromStock;
  const cost = missing * PARTS[o].price;
  if (cost > 0) {
    const paid = await prisma.company.updateMany({ where: { id: companyId, balance: { gte: cost } }, data: { balance: { decrement: cost } } });
    if (!paid.count) {
      // pas de quoi payer : on rend les pièces prises et on libère l'atelier
      if (fromStock) {
        const c = await prisma.company.findUnique({ where: { id: companyId }, select: { partsStock: true } });
        const stock = readStock(c?.partsStock);
        await prisma.company.update({ where: { id: companyId }, data: { partsStock: { ...stock, [o]: (stock[o] ?? 0) + fromStock } as Prisma.InputJsonValue } });
      }
      await prisma.wreck.update({ where: { id: w.id }, data: { working: null, workUntil: null } });
      return { ok: false, status: 409, error: `Trésorerie insuffisante (${cost} pièces pour ${missing} ${missing > 1 ? PARTS[o].plural : PARTS[o].part.toLowerCase()})` };
    }
    await prisma.transaction.create({ data: { companyId, type: "REPARATION", amount: -cost, description: `Restauration (${PARTS[o].label.toLowerCase()}) : ${kind.label} ${w.serial}` } });
  }
  const finalUntil = missing > 0 ? new Date(until.getTime() + PARTS[o].delayMin * 60_000) : until;
  await prisma.wreck.update({
    where: { id: w.id },
    data: { workUntil: finalUntil, spent: { increment: cost + fromStock * PARTS[o].price } },
  });
  return { ok: true, data: { organ: o, fromStock, ordered: missing, cost, workUntil: finalUntil } };
}

export async function commissionWreck(companyId: string, wreckId: string, name: string | undefined, now = new Date()): Promise<Result> {
  const w = await prisma.wreck.findFirst({ where: { id: wreckId, companyId } });
  if (!w) return { ok: false, status: 404, error: "Épave introuvable" };
  if (w.trainId) return { ok: false, status: 409, error: "Cette rame roule déjà" };
  if (w.restored.length < ORGANS.length) return { ok: false, status: 409, error: "La restauration n'est pas terminée" };
  const kind = WRECK_KINDS[w.kind];
  const clean = String(name ?? "").trim().slice(0, 40) || `${kind.label} ${w.serial}`;
  const heritage: Heritage = {
    wreckId: w.id, kind: w.kind, label: kind.label, rarity: w.rarity as Rarity, serial: w.serial, year: w.year, history: w.history,
    skin: kind.skin, livery: kind.livery, prestige: kind.prestige, value: w.spent,
  };
  try {
    const train = await prisma.$transaction(async (tx) => {
      const t = await tx.train.create({
        data: { name: clean, model: kind.model, companyId, organs: freshBias() as unknown as Prisma.InputJsonValue, heritage: heritage as unknown as Prisma.InputJsonValue },
      });
      const marked = await tx.wreck.updateMany({ where: { id: w.id, trainId: null }, data: { trainId: t.id, completedAt: now } });
      if (!marked.count) throw new Error("DEJA");
      await tx.transaction.create({ data: { companyId, type: "ACHAT_TRAIN", amount: 0, description: `Remise en service : ${kind.label} ${w.serial}` } });
      return t;
    });
    return { ok: true, data: { train, heritage } };
  } catch (e) {
    if ((e as Error).message === "DEJA") return { ok: false, status: 409, error: "Cette rame roule déjà" };
    throw e;
  }
}

/* la vue complète : ce qui attend preneur, ce qui est au dépôt, les dernières trouvailles des autres */
export async function wrecksFor(companyId: string, now = new Date()) {
  const [open, mine, recent, company] = await Promise.all([
    prisma.wreck.findMany({ where: { companyId: null, expiresAt: { gt: now } }, orderBy: { discoveredAt: "desc" } }),
    prisma.wreck.findMany({ where: { companyId, trainId: null }, orderBy: { claimedAt: "asc" } }),
    prisma.wreck.findMany({
      where: { companyId: { not: null }, claimedAt: { gte: new Date(now.getTime() - 86_400_000) } },
      orderBy: { claimedAt: "desc" },
      take: 6,
      include: { company: { select: { name: true } } },
    }),
    prisma.company.findUnique({ where: { id: companyId }, select: { partsStock: true, maxTrains: true } }),
  ]);
  const stock = readStock(company?.partsStock);
  return {
    open: open.map((w) => wreckView(w)),
    mine: mine.map((w) => wreckView(w, stock)),
    recent: recent.map((w) => ({
      label: WRECK_KINDS[w.kind]?.label ?? w.kind,
      rarity: w.rarity,
      serial: w.serial,
      station: w.station,
      company: (w as unknown as { company?: { name: string } }).company?.name ?? "Une compagnie",
      mine: w.companyId === companyId,
      commissioned: Boolean(w.trainId),
      at: w.claimedAt,
    })),
    depot: { used: await depotUse(companyId), max: company?.maxTrains ?? 0 },
    limit: MAX_WRECKS_PER_COMPANY,
  };
}
