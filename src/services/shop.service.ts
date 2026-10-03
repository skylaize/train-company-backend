import { RELEASE_171 } from "../release";
import { prisma } from "../prisma";
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

export type ShopItemKind = "LIVREES" | "EMBLEMES" | "TITRES" | "THEME" | "CABINE" | "SAISON" | "SANS_PUB" | "COFFRET" | "PLAQUE";

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
}

const ALL_ITEMS: ShopItem[] = [
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

// 1.7.1 : ces objets n'apparaissent qu'à la sortie de la 1.7.1 (src/release.ts)
const ITEMS_171 = new Set(["coffret-belle-epoque", "coffret-grande-vitesse", "cabine-duplex", "plaques-honneur", "emblemes-atelier"]);
export const SHOP_ITEMS: ShopItem[] = ALL_ITEMS.filter((i) => RELEASE_171 || !ITEMS_171.has(i.id));

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

  for (const item of SHOP_ITEMS) {
    if (!owned.has(item.id)) continue;
    item.liveries?.forEach((c) => liveries.add(c.toLowerCase()));
    item.emblems?.forEach((e) => emblems.add(e));
    item.titles?.forEach((t) => titles.add(t));
    if (item.theme) themes.add(item.theme);
    item.cabSkins?.forEach((c) => cabSkins.add(c));
    item.plates?.forEach((p) => plates.add(p));
  }

  if ((company?.referralMilestone ?? 0) >= 5) titles.add(EARNED_SPONSOR_TITLE);
  // 1.4 : chaque grade à partir du Directeur régional donne son nom en titre
  careerTitles(career.currentRank.id).forEach((t) => titles.add(t));

  return { owned, liveries, emblems, titles, themes, cabSkins, plates };
}
