import { prisma } from "../prisma";

/* ============================================================
   Extensions (DLC) — 2.0.

   La boutique ne vendait que de l'identité : couleurs, emblèmes, titres.
   Une extension, elle, ajoute du JEU : du matériel qui se joue autrement,
   des gares où l'on ne pouvait pas aller. La règle qui protège les joueurs
   gratuits reste la même dans l'esprit : rien ici n'est simplement « plus
   fort ». Chaque rame d'extension gagne d'un côté ce qu'elle perd de
   l'autre, et rapporte à l'heure à peu près ce que rapporte le matériel
   de base sur la ligne qui lui convient. On achète une autre façon de
   jouer, pas une avance au classement.

   Le Premium inclut « Trains de légende » tant que l'abonnement court.
   ============================================================ */

export interface DlcModel {
  id: string;
  label: string;
  cost: number;
  minGradeId: number;
  seats: number;
  fare: number; // multiplicateur du billet
  speed: number; // multiplicateur de la durée de trajet (> 1 = plus lent)
  wear: number; // multiplicateur d'usure
  minDuration?: number; // ne fait que les lignes d'au moins cette durée
  weekendDemand?: number; // affluence en plus le week-end
  blurb: string;
}

export interface Dlc {
  id: string; // = id de l'objet de boutique
  name: string;
  tagline: string;
  description: string;
  priceCents: number;
  premium: boolean; // inclus dans le Premium
  models: DlcModel[];
  stations: string[];
  features: string[];
}

export const DLCS: Dlc[] = [
  {
    id: "dlc-legende",
    name: "Trains de légende",
    tagline: "La vapeur et le grand luxe",
    description:
      "Deux rames qui ne se jouent pas comme les autres : une locomotive à vapeur que les touristes s'arrachent le week-end, et un train de grand luxe pour les longues lignes. Inclus dans le Premium.",
    priceCents: 399,
    premium: true,
    models: [
      {
        id: "VAPEUR",
        label: "Vapeur",
        cost: 600,
        minGradeId: 1,
        seats: 300,
        fare: 1.35,
        speed: 1.3,
        wear: 1.6,
        weekendDemand: 1.4,
        blurb: "300 places, billet ×1,35, affluence +40 % le week-end. Lente et gourmande en entretien.",
      },
      {
        id: "LUXE",
        label: "Grand luxe",
        cost: 1600,
        minGradeId: 3,
        seats: 120,
        fare: 3.8,
        speed: 1.1,
        wear: 1.2,
        minDuration: 12,
        blurb: "120 places à 3,8 fois le billet, sur les lignes d'au moins 12 minutes. Une rame vide coûte cher.",
      },
    ],
    stations: [],
    features: ["2 rames exclusives", "Vue cabine : la vapeur et son panache", "Livrée « Vert Pullman » et titre « Compagnie de légende »"],
  },
  {
    id: "dlc-montagne",
    name: "Montagne",
    tagline: "Quatre gares d'altitude et la crémaillère",
    description:
      "Chamonix, Bourg-Saint-Maurice, Briançon et Font-Romeu rejoignent votre carte. Les stations se remplissent l'hiver et l'été, et la rame à crémaillère est la seule qui y monte sans s'user deux fois plus vite.",
    priceCents: 399,
    premium: false,
    models: [
      {
        id: "CREMAILLERE",
        label: "Crémaillère",
        cost: 500,
        minGradeId: 1,
        seats: 220,
        fare: 1.15,
        speed: 1.35,
        wear: 0.9,
        blurb: "220 places, billet ×1,15. Lente, mais elle ne craint pas la pente.",
      },
    ],
    stations: ["Chamonix", "Bourg-Saint-Maurice", "Briançon", "Font-Romeu"],
    features: ["4 gares d'altitude", "Saison de ski et saison d'été : affluence ×1,8 l'hiver, ×1,3 l'été", "Rame à crémaillère", "Emblème du sommet"],
  },
];

export const DLC_MODELS: Record<string, DlcModel & { dlc: string }> = Object.fromEntries(
  DLCS.flatMap((d) => d.models.map((m) => [m.id, { ...m, dlc: d.id }]))
);
export const MOUNTAIN_STATIONS = DLCS.find((d) => d.id === "dlc-montagne")!.stations;
// une rame autre que la crémaillère s'use deux fois plus vite sur une ligne de montagne
export const MOUNTAIN_WEAR = 1.8;

export function dlcById(id: string) {
  return DLCS.find((d) => d.id === id) ?? null;
}

/* Affluence des gares de montagne selon le mois (heure de Paris). */
export function mountainDemand(now = new Date()) {
  const month = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", month: "numeric" }).format(now));
  if (month === 12 || month <= 3) return 1.8;
  if (month >= 7 && month <= 8) return 1.3;
  return 0.8;
}

export function isWeekend(now = new Date()) {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", weekday: "short" }).format(now);
  return day === "Sat" || day === "Sun";
}

/* Extensions d'une compagnie : achetées, ou incluses dans son Premium. */
export async function ownedDlcs(companyId: string): Promise<Set<string>> {
  const [rows, company] = await Promise.all([
    prisma.shopPurchase.findMany({ where: { companyId, itemId: { in: DLCS.map((d) => d.id) } }, select: { itemId: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { isPremium: true } }),
  ]);
  const out = new Set((rows as { itemId: string }[]).map((r) => r.itemId));
  if (company?.isPremium) DLCS.filter((d) => d.premium).forEach((d) => out.add(d.id));
  return out;
}

export async function stationNeedsDlc(companyId: string, station: string) {
  if (!MOUNTAIN_STATIONS.includes(station)) return null;
  const owned = await ownedDlcs(companyId);
  return owned.has("dlc-montagne") ? null : "Montagne";
}
