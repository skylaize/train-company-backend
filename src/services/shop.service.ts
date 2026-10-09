import { RELEASE_171 } from "../release";
import { seasonUnlocks } from "./saison.service";
import { isBuilder, BUILDER_EMBLEM } from "./world.service";

// 2.0 : la livrée offerte à toutes les compagnies pour le lancement
export const V2_GIFT_LIVERY = "#1e6091";
import { prisma } from "../prisma";
import { parisDate, parisMidnight } from "./time.service";
import { DLCS, ownedDlcs } from "./dlc.service";
import { passUnlocks, passSeasonNumber, PASS_PRICE_CENTS } from "./pass.service";
import { computeCareerStatus, careerTitles } from "./career.service";

/* ============================================================
   Boutique — objets cosmétiques.

   Règle unique, qui décide de tout ce qui entre ou non dans ce catalogue :
   RIEN ICI NE CHANGE UN CHIFFRE DU JEU. Pas de pièces, pas de chantier
   accéléré, pas de capacité, pas de rendement. On vend de l'identité — une
   couleur, un emblème, un titre, un habillage — et un joueur gratuit doit
   pouvoir finir premier du classement exactement comme avant.

   Ce n'est pas un scrupule gratuit : toute l'économie du jeu repose sur le
   temps comme contrainte. Vendre du temps reviendrait à vendre la fin du jeu.

   Délibérément absent : le renommage d'une gare. Un texte libre affiché sur
   la carte de tous les joueurs demande une modération que le jeu n'a pas. Les
   titres, eux, sont choisis dans une liste fermée pour la même raison.
   ============================================================ */

export type ShopItemKind = "PASS" | "DLC" | "LIVREES" | "EMBLEMES" | "TITRES" | "THEME" | "CABINE" | "SAISON" | "SANS_PUB" | "COFFRET" | "PLAQUE";

export interface ShopItem {
  id: string;
  kind: ShopItemKind;
  name: string;
  description: string;
  priceCents: number;
  // contenu débloqué, lu par l'interface et par les vérifications serveur
  liveries?: string[];
  emblems?: string[];
  titles?: string[];
  theme?: string;
  cabSkins?: string[];
  // 1.7 : plaques d'honneur, visibles par tous au classement
  plates?: string[];
  // 1.5 : édition limitée, vendue seulement pendant ce temps fort de saison
  season?: string;
  // 1.7 : mis en avant en tête de boutique
  isNew?: boolean;
  // 1.7 : prix des pièces achetées séparément, pour afficher l'économie d'un coffret
  worthCents?: number;
  // 2.0 : extension de jeu (voir dlc.service)
  dlc?: { tagline: string; premium: boolean; features: string[]; models: { id: string; label: string; blurb: string }[]; stations: string[] };
}

/* 2.0 : les extensions. Seule exception à la règle ci-dessous : elles
   ajoutent du jeu (matériel, gares), jamais un avantage net — voir dlc.service. */
export const LEGEND_LIVERY = "#24493a";
const DLC_ITEMS: ShopItem[] = DLCS.map((d) => ({
  id: d.id,
  kind: "DLC" as const,
  name: d.name,
  description: d.description,
  priceCents: d.priceCents,
  isNew: true,
  liveries: d.id === "dlc-legende" ? [LEGEND_LIVERY] : undefined,
  titles: d.id === "dlc-legende" ? ["Compagnie de légende"] : undefined,
  emblems: d.id === "dlc-montagne" ? ["sommet"] : undefined,
  cabSkins: d.id === "dlc-legende" ? ["vapeur"] : undefined,
  dlc: { tagline: d.tagline, premium: d.premium, features: d.features, models: d.models.map((m) => ({ id: m.id, label: m.label, blurb: m.blurb })), stations: d.stations },
}));

const ALL_ITEMS: ShopItem[] = [
  ...DLC_ITEMS,
  {
    id: "livrees-epoque",
    kind: "LIVREES",
    name: "Livrées d'époque",
    description: "Quatre couleurs du grand âge du rail : vert voiture-lit, bordeaux, bleu Mistral, crème.",
    priceCents: 199,
    liveries: ["#2f4a3a", "#6b1f2a", "#1f3b73", "#d8cfa8"],
  },
  {
    id: "livrees-vives",
    kind: "LIVREES",
    name: "Livrées vives",
    description: "Quatre couleurs franches pour se voir de loin sur la carte : orange signal, or, émeraude, violet.",
    priceCents: 199,
    liveries: ["#e0561b", "#d4a017", "#2f9e6a", "#7a3f9e"],
  },
  {
    id: "emblemes",
    kind: "EMBLEMES",
    name: "Emblèmes de compagnie",
    description: "Six emblèmes à placer devant le nom de votre compagnie, dans la console et au classement.",
    priceCents: 299,
    emblems: ["roue", "etoile", "aile", "couronne", "ancre", "eclair"],
  },
  {
    id: "titres",
    kind: "TITRES",
    name: "Titres honorifiques",
    description: "Quatre titres à afficher au classement à côté de votre compagnie.",
    priceCents: 199,
    titles: ["Chef de gare", "Maître aiguilleur", "Architecte du réseau", "Seigneur des rails"],
  },
  // ---- 1.4 ----
  {
    id: "livrees-regionales",
    kind: "LIVREES",
    name: "Livrées régionales",
    description: "Quatre couleurs de nos régions : bleu Bretagne, rouge Alsace, lavande de Provence, vert Normandie.",
    priceCents: 199,
    liveries: ["#1d4e89", "#b3261e", "#8a79b8", "#3f7d3a"],
  },
  {
    id: "emblemes-reseau",
    kind: "EMBLEMES",
    name: "Emblèmes du réseau",
    description: "Quatre emblèmes tirés du monde ferroviaire : le rail, la boussole, l'horloge de gare et le viaduc.",
    priceCents: 299,
    emblems: ["rail", "boussole", "horloge", "viaduc"],
  },
  {
    id: "titres-legende",
    kind: "TITRES",
    name: "Titres de légende",
    description: "Quatre titres de plus pour le classement : Roi des aiguillages, Voyageur infatigable, Grand horloger, Maître du fret.",
    priceCents: 199,
    titles: ["Roi des aiguillages", "Voyageur infatigable", "Grand horloger", "Maître du fret"],
  },
  {
    id: "cabine-collection",
    kind: "CABINE",
    name: "Matériel de collection",
    description: "Dans la vue cabine, faites rouler une locomotive à vapeur et son panache, ou une Micheline rouge et crème. Uniquement pour le plaisir des yeux.",
    priceCents: 399,
    cabSkins: ["vapeur", "micheline"],
  },
  // ---- 1.5 : éditions de saison, en vente seulement pendant leur temps fort ----
  {
    id: "coffret-vendanges",
    kind: "SAISON",
    name: "Coffret des Vendanges",
    description: "Édition limitée : la livrée lie-de-vin et l'emblème de la grappe. En vente pendant les Vendanges seulement.",
    priceCents: 199,
    liveries: ["#6b1f3a"],
    emblems: ["grappe"],
    season: "vendanges",
  },
  {
    id: "coffret-noel",
    kind: "SAISON",
    name: "Coffret de Noël",
    description: "Édition limitée : la livrée vert sapin et l'emblème du sapin. En vente pendant les Marchés de Noël seulement.",
    priceCents: 199,
    liveries: ["#1f4d3a"],
    emblems: ["sapin"],
    season: "noel",
  },
  {
    id: "coffret-neiges",
    kind: "SAISON",
    name: "Coffret des Neiges",
    description: "Édition limitée : la livrée blanc glacier et l'emblème du flocon. En vente pendant les Vacances de neige seulement.",
    priceCents: 199,
    liveries: ["#c9d9e6"],
    emblems: ["flocon"],
    season: "neige",
  },
  {
    id: "coffret-ete",
    kind: "SAISON",
    name: "Coffret de l'Été",
    description: "Édition limitée : la livrée jaune soleil et l'emblème du soleil. En vente pendant les Grandes Vacances seulement.",
    priceCents: 199,
    liveries: ["#e0a526"],
    emblems: ["soleil"],
    season: "ete",
  },
  // ---- 1.7 ----
  {
    id: "coffret-belle-epoque",
    kind: "COFFRET",
    name: "Coffret Belle Époque",
    description: "Tout le chic des grands express d'antan : les voitures Pullman bordeaux filetées d'or en vue cabine, la livrée bordeaux impérial, l'emblème de la lanterne et le titre « Compagnie Belle Époque ».",
    priceCents: 499,
    worthCents: 799,
    liveries: ["#5b1e2d"],
    emblems: ["lanterne"],
    titles: ["Compagnie Belle Époque"],
    cabSkins: ["pullman"],
    isNew: true,
  },
  {
    id: "coffret-grande-vitesse",
    kind: "COFFRET",
    name: "Coffret Grande Vitesse",
    description: "Une rame à grande vitesse au long nez profilé en vue cabine, la livrée argent, l'emblème de la flèche et le titre « Pionnier de la grande vitesse ».",
    priceCents: 399,
    worthCents: 649,
    liveries: ["#c4ccd4"],
    emblems: ["fleche"],
    titles: ["Pionnier de la grande vitesse"],
    cabSkins: ["grande-vitesse"],
    isNew: true,
  },
  {
    id: "cabine-duplex",
    kind: "CABINE",
    name: "Rame à deux niveaux",
    description: "En vue cabine, une rame à étage aux deux rangées de fenêtres, à votre livrée. La nuit, les deux niveaux s'allument.",
    priceCents: 299,
    cabSkins: ["duplex"],
    isNew: true,
  },
  {
    id: "plaques-honneur",
    kind: "PLAQUE",
    name: "Plaques d'honneur",
    description: "Votre nom encadré au classement, vu par tous les joueurs : laiton gravé, émail bleu de gare ou or fin. Trois plaques, à changer quand vous voulez.",
    priceCents: 249,
    plates: ["laiton", "email", "or"],
    isNew: true,
  },
  {
    id: "emblemes-atelier",
    kind: "EMBLEMES",
    name: "Emblèmes de l'atelier",
    description: "Deux emblèmes de plus, tirés du dépôt : l'aiguillage et le sifflet du chef de gare.",
    priceCents: 149,
    emblems: ["aiguillage", "sifflet"],
    isNew: true,
  },
  {
    id: "theme-plan-1935",
    kind: "THEME",
    name: "Habillage « Plan 1935 »",
    description: "Un troisième habillage de la console : bleu de tirage et trait blanc, comme un plan d'ingénieur.",
    priceCents: 299,
    theme: "plan",
  },
];

/* 2.0 : des objets à l'unité, pour que la boutique du jour ne se répète pas.
   Une livrée ou un titre seul, à 0,99 €. */
const SINGLE_LIVERIES: [string, string, string][] = [
  ["livree-prusse", "Bleu de Prusse", "#1f3b5a"],
  ["livree-wagon", "Vert wagon", "#2e5a3c"],
  ["livree-signal", "Rouge signal", "#c23b22"],
  ["livree-catenaire", "Jaune caténaire", "#e5b13a"],
  ["livree-beton", "Gris béton", "#7c8590"],
  ["livree-turquoise", "Turquoise", "#2a9d8f"],
  ["livree-prune", "Prune", "#6b2f4f"],
  ["livree-corail", "Corail", "#e07a5f"],
  ["livree-minuit", "Bleu minuit", "#14213d"],
  ["livree-anis", "Vert anis", "#9bc53d"],
  ["livree-sepia", "Sépia", "#704214"],
  ["livree-rose-quai", "Rose quai", "#d88aa5"],
  ["livree-acier", "Acier", "#4a5d6b"],
  ["livree-ocre", "Ocre", "#c58b2a"],
];
const SINGLE_TITLES: [string, string][] = [
  ["titre-aiguilleur-nuit", "Aiguilleur de nuit"],
  ["titre-voix-quai", "Voix du quai"],
  ["titre-ponctualite", "Roi de la ponctualité"],
  ["titre-ballast", "Baron du ballast"],
  ["titre-capitaine-depot", "Capitaine de dépôt"],
  ["titre-ami-voyageurs", "Ami des voyageurs"],
  ["titre-correspondances", "Faiseur de correspondances"],
  ["titre-catenaires", "Prince des caténaires"],
];
const SINGLES: ShopItem[] = [
  ...SINGLE_LIVERIES.map(([id, name, color]) => ({
    id,
    kind: "LIVREES" as const,
    name: `Livrée « ${name} »`,
    description: `Une livrée ${name.toLowerCase()} pour toutes vos rames, sur la carte et en vue cabine.`,
    priceCents: 99,
    liveries: [color],
  })),
  ...SINGLE_TITLES.map(([id, title]) => ({
    id,
    kind: "TITRES" as const,
    name: `Titre « ${title} »`,
    description: "Un titre à afficher au classement, à côté du nom de votre compagnie.",
    priceCents: 99,
    titles: [title],
  })),
];

// 1.7.1 : ces objets n'apparaissent qu'à la sortie de la 1.7.1 (src/release.ts)
const ITEMS_171 = new Set(["coffret-belle-epoque", "coffret-grande-vitesse", "cabine-duplex", "plaques-honneur", "emblemes-atelier"]);
export const SHOP_ITEMS: ShopItem[] = [...ALL_ITEMS.filter((i) => RELEASE_171 || !ITEMS_171.has(i.id)), ...SINGLES];

/* ============================================================
   La boutique du jour (2.0).

   Comme dans les jeux qui la font vivre, la boutique change chaque nuit à
   minuit (heure de Paris) : deux objets « à la une », six « du jour ». Le
   tirage dépend seulement de la date, donc tout le monde voit la même
   boutique, et rien ne se perd : un objet revient quelques jours plus tard.
   Toujours en vente, hors rotation : le Pass de saison, les extensions, le
   billet sans pub, et les éditions limitées pendant leur temps fort.
   ============================================================ */
const BIG_KINDS = new Set(["COFFRET", "CABINE", "THEME", "PLAQUE", "EMBLEMES"]);
export const ROTATING = SHOP_ITEMS.filter((i) => i.kind !== "DLC" && i.kind !== "SAISON");
const FEATURED_POOL = ROTATING.filter((i) => BIG_KINDS.has(i.kind) || (i.liveries?.length ?? 0) > 1 || (i.titles?.length ?? 0) > 1);
export const FEATURED_COUNT = 2;
export const DAILY_COUNT = 6;

function dayKey(now = new Date()) {
  const d = parisDate(now);
  return { ...d, key: `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` };
}

function seeded(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  let x = h >>> 0;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return x / 4294967296;
  };
}

function pick<T>(pool: T[], n: number, rnd: () => number, avoid: Set<T> = new Set()) {
  const left = pool.filter((x) => !avoid.has(x));
  const out: T[] = [];
  while (out.length < n && left.length) out.push(left.splice(Math.floor(rnd() * left.length), 1)[0]);
  return out;
}

// la une suit un roulement fixe (jamais deux jours de suite), le reste est tiré au sort
const FEATURED_ORDER = (() => {
  const rnd = seeded("reseau-une");
  return pick(FEATURED_POOL, FEATURED_POOL.length, rnd);
})();
const SINGLE_IDS = new Set(SINGLES.map((i) => i.id));

export function dailyRotation(now = new Date()) {
  const d = dayKey(now);
  const index = Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
  const n = FEATURED_ORDER.length;
  const featured = [FEATURED_ORDER[(index * FEATURED_COUNT) % n], FEATURED_ORDER[(index * FEATURED_COUNT + 1) % n]];
  const rnd = seeded(`reseau-${d.key}`);
  const taken = new Set(featured);
  const singles = pick(ROTATING.filter((i) => SINGLE_IDS.has(i.id)), 4, rnd, taken);
  const packs = pick(ROTATING.filter((i) => !SINGLE_IDS.has(i.id)), DAILY_COUNT - singles.length, rnd, taken);
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const t = parisDate(tomorrow);
  return {
    day: d.key,
    featured: featured.map((i) => i.id),
    daily: [...packs, ...singles].map((i) => i.id),
    refreshAt: parisMidnight(t.year, t.month, t.day),
  };
}

/* Un objet de la rotation n'est en vente que le jour où il est en boutique. */
export function inShopToday(itemId: string, now = new Date()) {
  if (!ROTATING.some((i) => i.id === itemId)) return true;
  const r = dailyRotation(now);
  return r.featured.includes(itemId) || r.daily.includes(itemId);
}

/* 1.7 : le billet sans pub. Vendu par le même circuit que la boutique (prix
   transmis à Stripe à la volée), mais pas affiché parmi les objets : il a son
   bouton sous la bannière. Le Premium inclut déjà l'absence de publicité. */
export const AD_FREE_ITEM_ID = "sans-pub";
export const AD_FREE_ITEM: ShopItem = {
  id: AD_FREE_ITEM_ID,
  kind: "SANS_PUB",
  name: "Billet sans pub",
  description: "Plus aucune bannière publicitaire dans Réseau, pour toujours. Les vidéos récompensées restent possibles, si vous les demandez.",
  priceCents: 199,
};

export async function hasAdFree(companyId: string) {
  const row = await prisma.shopPurchase.findUnique({ where: { companyId_itemId: { companyId, itemId: AD_FREE_ITEM_ID } } });
  return Boolean(row);
}

export function findItem(id: string) {
  if (id === AD_FREE_ITEM_ID) return RELEASE_171 ? AD_FREE_ITEM : null;
  // 2.0 : un pass de saison (sa saison est vérifiée au moment du paiement)
  if (passSeasonNumber(id) !== null) {
    return { id, kind: "PASS", name: "Pass de saison", description: "Le Pass de saison de Réseau", priceCents: PASS_PRICE_CENTS } as unknown as ShopItem;
  }
  return SHOP_ITEMS.find((i) => i.id === id) ?? null;
}

/* Titre gagné en jeu, jamais vendu : il reste disponible à côté des titres
   achetés, et il n'écrase pas un titre choisi par le joueur. */
export const EARNED_SPONSOR_TITLE = "Recruteur du rail";

export async function ownedItemIds(companyId: string) {
  const rows = await prisma.shopPurchase.findMany({
    where: { companyId },
    select: { itemId: true },
  });
  return new Set((rows as { itemId: string }[]).map((r) => r.itemId));
}

/* Tout ce qu'une compagnie a le droit de porter, en un seul objet : c'est ce
   que consultent les vérifications serveur avant d'accepter un changement de
   livrée, d'emblème, de titre ou d'habillage. */
export async function unlockedFor(companyId: string) {
  const [owned, company, career] = await Promise.all([
    ownedItemIds(companyId),
    prisma.company.findUnique({ where: { id: companyId }, select: { referralMilestone: true } }),
    computeCareerStatus(companyId),
  ]);

  const liveries = new Set<string>();
  const emblems = new Set<string>();
  const titles = new Set<string>();
  const themes = new Set<string>(["sombre", "papier"]);
  const cabSkins = new Set<string>();
  const plates = new Set<string>();

  // 2.0 : une extension incluse dans le Premium débloque aussi ses objets
  const dlcs = await ownedDlcs(companyId);
  for (const item of SHOP_ITEMS) {
    if (!owned.has(item.id) && !dlcs.has(item.id)) continue;
    item.liveries?.forEach((c) => liveries.add(c.toLowerCase()));
    item.emblems?.forEach((e) => emblems.add(e));
    item.titles?.forEach((t) => titles.add(t));
    if (item.theme) themes.add(item.theme);
    item.cabSkins?.forEach((c) => cabSkins.add(c));
    item.plates?.forEach((p) => plates.add(p));
  }

  if ((company?.referralMilestone ?? 0) >= 5) titles.add(EARNED_SPONSOR_TITLE);
  // 2.0 : cadeau de lancement pour tous, récompenses de saison, emblème du tunnel
  liveries.add(V2_GIFT_LIVERY);
  const won = await seasonUnlocks(companyId);
  won.titles.forEach((t) => titles.add(t));
  won.liveries.forEach((c) => liveries.add(c.toLowerCase()));
  if (await isBuilder(companyId)) emblems.add(BUILDER_EMBLEM);
  // 2.0 : ce que les pass de saison ont fait gagner
  const pass = await passUnlocks(companyId).catch(() => null);
  if (pass) {
    pass.liveries.forEach((c) => liveries.add(c.toLowerCase()));
    pass.emblems.forEach((e) => emblems.add(e));
    pass.titles.forEach((t) => titles.add(t));
    pass.plates.forEach((p) => plates.add(p));
  }
  // 1.4 : chaque grade à partir du Directeur régional donne son nom en titre
  careerTitles(career.currentRank.id).forEach((t) => titles.add(t));

  return { owned, liveries, emblems, titles, themes, cabSkins, plates };
}
