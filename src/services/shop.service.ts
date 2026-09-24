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

export type ShopItemKind = "LIVREES" | "EMBLEMES" | "TITRES" | "THEME" | "CABINE";

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
}

export const SHOP_ITEMS: ShopItem[] = [
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
  {
    id: "theme-plan-1935",
    kind: "THEME",
    name: "Habillage « Plan 1935 »",
    description: "Un troisième habillage de la console : bleu de tirage et trait blanc, comme un plan d'ingénieur.",
    priceCents: 299,
    theme: "plan",
  },
];

export function findItem(id: string) {
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

  for (const item of SHOP_ITEMS) {
    if (!owned.has(item.id)) continue;
    item.liveries?.forEach((c) => liveries.add(c.toLowerCase()));
    item.emblems?.forEach((e) => emblems.add(e));
    item.titles?.forEach((t) => titles.add(t));
    if (item.theme) themes.add(item.theme);
    item.cabSkins?.forEach((c) => cabSkins.add(c));
  }

  if ((company?.referralMilestone ?? 0) >= 5) titles.add(EARNED_SPONSOR_TITLE);
  // 1.4 : chaque grade à partir du Directeur régional donne son nom en titre
  careerTitles(career.currentRank.id).forEach((t) => titles.add(t));

  return { owned, liveries, emblems, titles, themes, cabSkins };
}
