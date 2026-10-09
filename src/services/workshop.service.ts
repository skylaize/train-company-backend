import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { CARS } from "./ridership.service";

/* ============================================================
   L'atelier (2.0).

   Avant, une rame avait un seul chiffre d'usure et une panne se réglait d'un
   clic contre des pièces. Trois choses changent :

   1. LES ORGANES. Chaque rame a quatre organes — freins, bogies, moteur,
      caisse — qui ne s'usent pas au même rythme. L'usure générale reste le
      chiffre de référence (c'est elle qui atteint 100 %), et chaque organe en
      porte une part selon son poids. L'organe le plus chargé est celui qui
      lâche : c'est lui qu'il faudra remplacer.

   2. LA CASSE ET LES PIÈCES. Une rame cassée ne se répare plus d'un clic :
      il faut la pièce. Soit elle est au magasin (achetée d'avance), soit on
      la commande — livrée en 30 à 90 minutes, ou en express en 10 minutes,
      deux fois et demie plus cher. Pendant ce temps, la rame ne roule pas.
      C'est la vraie sanction d'une flotte mal entretenue : du temps perdu,
      que la trésorerie ne rattrape pas.

   3. L'ENTRETIEN PRÉVENTIF. Réviser une rame avant la casse coûte moins cher
      par point d'usure et ne demande pas de pièce, mais l'immobilise
      quelques minutes à l'atelier. On peut programmer la révision : la rame
      y passe d'elle-même en fin de trajet dès qu'elle atteint le seuil.

   Une rame négligée (85 % et plus) peut aussi casser avant 100 %, et un
   trajet peut mal finir : un animal, une branche, un objet sur la voie.
   Un conducteur affecté à la rame réduit ces deux risques.
   ============================================================ */

export const ORGANS = ["FREINS", "BOGIES", "MOTEUR", "CAISSE"] as const;
export type Organ = (typeof ORGANS)[number];
export type OrganBias = Record<Organ, number>;

// need : la pièce avec son article (« il faut un bogie complet ») ; plural : au magasin
export const PARTS: Record<Organ, { label: string; part: string; need: string; plural: string; price: number; delayMin: number }> = {
  FREINS: { label: "Freins", part: "Garnitures de frein", need: "des garnitures de frein", plural: "jeux de garnitures de frein", price: 60, delayMin: 30 },
  BOGIES: { label: "Bogies", part: "Bogie complet", need: "un bogie complet", plural: "bogies", price: 140, delayMin: 75 },
  MOTEUR: { label: "Moteur", part: "Moteur de traction", need: "un moteur de traction", plural: "moteurs de traction", price: 220, delayMin: 90 },
  CAISSE: { label: "Caisse", part: "Panneaux de caisse", need: "des panneaux de caisse", plural: "jeux de panneaux de caisse", price: 90, delayMin: 45 },
};
export const EXPRESS_FACTOR = 2.5;
export const EXPRESS_MIN = 10;
export const STOCK_MAX = 3; // par pièce, +1 par atelier possédé

export const NEGLECT_FROM = 85; // au-delà, la casse peut survenir avant 100 %
export const NEGLECT_CHANCE = 0.015; // par tour de 30 s
export const TRACK_INCIDENT_CHANCE = 0.012; // par trajet terminé
export const SERVICE_DISCOUNT = 0.6; // une révision coûte 60 % d'une réparation, par point
export const SERVICE_THRESHOLDS = [40, 60, 80];

/* Durée d'une révision : 3 minutes plus une minute par tranche de 10 % d'usure. */
export function serviceMinutes(wear: number) {
  return 3 + Math.ceil(Math.max(0, wear) / 10);
}

/* Poids des organes. Une rame qui n'en a pas encore (achetée avant la 2.0)
   reçoit des poids tirés de son identifiant : stables d'un affichage à
   l'autre, différents d'une rame à l'autre. */
function hashUnit(seed: string, salt: number) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

export function organBias(train: { id: string; organs?: unknown }): OrganBias {
  const o = (train.organs ?? null) as Partial<OrganBias> | null;
  const out = {} as OrganBias;
  ORGANS.forEach((k, i) => {
    const v = o && typeof o[k] === "number" ? (o[k] as number) : 0.55 + 0.45 * hashUnit(train.id, i + 1);
    out[k] = Math.max(0.2, Math.min(2, v));
  });
  return out;
}

export function freshBias(random = Math.random): OrganBias {
  return { FREINS: 0.6 + 0.4 * random(), BOGIES: 0.55 + 0.4 * random(), MOTEUR: 0.5 + 0.45 * random(), CAISSE: 0.45 + 0.4 * random() };
}

export function weakestOrgan(bias: OrganBias): Organ {
  return ORGANS.reduce((a, b) => (bias[b] > bias[a] ? b : a), ORGANS[0]);
}

/* L'état affiché de chaque organe, en pourcentage. */
export function organWear(train: { id: string; organs?: unknown; wear: number; brokenPart?: string | null }) {
  const bias = organBias(train);
  const max = Math.max(...ORGANS.map((k) => bias[k]));
  return ORGANS.map((k) => ({
    id: k,
    label: PARTS[k].label,
    // une rame cassée : l'organe en cause est à 100 %, les autres restent en dessous
    wear: train.brokenPart === k ? 100 : Math.min(train.brokenPart ? 95 : 100, Math.round((train.wear * bias[k]) / max)),
    broken: train.brokenPart === k,
  }));
}

/* ---------- magasin ---------- */

export type Stock = Partial<Record<Organ, number>>;

export function readStock(raw: unknown): Stock {
  const out: Stock = {};
  if (raw && typeof raw === "object") {
    for (const k of ORGANS) {
      const v = Number((raw as Record<string, unknown>)[k]);
      if (Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
    }
  }
  return out;
}

export async function stockLimit(companyId: string) {
  const shops = await prisma.workshop.count({ where: { companyId } }).catch(() => 0);
  return STOCK_MAX + shops;
}

/* Retire une pièce du stock, de façon sûre si deux réparations arrivent en
   même temps : la mise à jour ne passe que si la quantité lue est toujours là. */
export async function takeFromStock(companyId: string, part: Organ): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await prisma.company.findUnique({ where: { id: companyId }, select: { partsStock: true } });
    if (!c) return false;
    const stock = readStock(c.partsStock);
    const have = stock[part] ?? 0;
    if (have <= 0) return false;
    const next = { ...stock, [part]: have - 1 };
    const done = await prisma.$executeRaw`
      UPDATE "Company" SET "partsStock" = ${JSON.stringify(next)}::jsonb
      WHERE "id" = ${companyId} AND "partsStock" = ${JSON.stringify(c.partsStock ?? {})}::jsonb`;
    if (done > 0) return true;
  }
  return false;
}

/* ---------- réparation d'une casse ---------- */

export type RepairMode = "stock" | "order" | "express";

export function partPrice(part: Organ, mode: RepairMode) {
  if (mode === "stock") return 0;
  return Math.round(PARTS[part].price * (mode === "express" ? EXPRESS_FACTOR : 1));
}

export function partDelayMs(part: Organ, mode: RepairMode) {
  if (mode === "stock") return 0;
  return (mode === "express" ? EXPRESS_MIN : PARTS[part].delayMin) * 60_000;
}

/* La rame remise en état : en route si elle a une ligne, à quai sinon. */
export function backInService(lineId: string | null): Prisma.TrainUncheckedUpdateInput {
  return lineId
    ? { status: "EN_ROUTE", progress: 0, departedAt: new Date() }
    : { status: "IDLE", progress: 0, departedAt: null };
}

/* Panne d'une rame : l'organe le plus chargé lâche. */
export function breakdownData(train: { id: string; organs?: unknown }, part?: Organ): Prisma.TrainUncheckedUpdateInput {
  const bias = organBias(train);
  return { wear: 100, status: "MAINTENANCE", brokenPart: part ?? weakestOrgan(bias), organs: bias as unknown as Prisma.InputJsonValue };
}

/* ---------- incidents sur la voie ---------- */

export const TRACK_INCIDENTS: { id: string; organ: Organ; wear: number; breakChance: number; text: (train: string, place: string) => string }[] = [
  { id: "ANIMAL", organ: "CAISSE", wear: 14, breakChance: 0.15, text: (t, p) => `${t} a heurté un sanglier près de ${p}` },
  { id: "BRANCHE", organ: "MOTEUR", wear: 10, breakChance: 0.2, text: (t, p) => `Une branche tombée sur la caténaire a arrêté ${t} près de ${p}` },
  { id: "OBJET", organ: "BOGIES", wear: 18, breakChance: 0.3, text: (t, p) => `${t} a roulé sur un objet abandonné sur la voie près de ${p}` },
  { id: "FREINAGE", organ: "FREINS", wear: 12, breakChance: 0.15, text: (t, p) => `Freinage d'urgence de ${t} devant ${p} : un troupeau traversait` },
];

/* ---------- revente (Premium) ---------- */

export const RESALE_START = 0.65; // une rame neuve se revend 65 % de son prix
export const RESALE_FLOOR = 0.3;
export const RESALE_LOSS_PER_DAY = 0.01;

export function resaleValue(t: { model: string; wear: number; cars?: string[] | null; purchasedAt: Date | string; brokenPart?: string | null }, modelCost: number) {
  const ageDays = Math.max(0, (Date.now() - new Date(t.purchasedAt).getTime()) / 86_400_000);
  const share = Math.max(RESALE_FLOOR, RESALE_START - RESALE_LOSS_PER_DAY * ageDays);
  const condition = 1 - Math.min(100, t.wear) / 250; // une rame à 100 % perd encore 40 %
  const broken = t.brokenPart ? 0.85 : 1;
  const cars = (t.cars ?? []).reduce((n, c) => n + Math.floor((CARS[c]?.price ?? 0) / 2), 0);
  return Math.max(10, Math.round(modelCost * share * condition * broken) + cars);
}

/* ---------- le passage régulier : sorties d'atelier et livraisons ---------- */

export async function runWorkshop(now = new Date()) {
  /* Une rame ne sort de l'atelier que si elle y est encore (statut
     « en panne ») : une écriture concurrente a pu la remettre en service
     entre-temps, et la renvoyer à quai couperait une livraison en cours. */
  const serviced = await prisma.train.findMany({
    where: { workshopUntil: { lte: now } },
    select: { id: true, lineId: true, status: true },
  });
  for (const t of serviced) {
    await prisma.train.update({ where: { id: t.id }, data: t.status === "MAINTENANCE" ? { workshopUntil: null, ...backInService(t.lineId) } : { workshopUntil: null } });
  }
  // pièces livrées : la rame est réparée à l'arrivée de la pièce
  const delivered = await prisma.train.findMany({
    where: { partsEta: { lte: now } },
    select: { id: true, lineId: true, name: true, companyId: true, brokenPart: true, status: true },
  });
  for (const t of delivered) {
    await prisma.train.update({
      where: { id: t.id },
      data:
        t.status === "MAINTENANCE"
          ? { partsEta: null, brokenPart: null, wear: 0, organs: freshBias() as unknown as Prisma.InputJsonValue, ...backInService(t.lineId) }
          : { partsEta: null, brokenPart: null },
    });
  }
  return delivered as { id: string; name: string; companyId: string; brokenPart: string | null }[];
}
