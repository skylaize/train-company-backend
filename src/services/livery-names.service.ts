import { SINGLE_LIVERIES, V2_GIFT_LIVERY, LEGEND_LIVERY, DISCORD_LIVERY } from "./shop.service";
import { CORSICA_LIVERY } from "./dlc.service";
import { SPECTRAL_LIVERY } from "./halloween.service";
import { BOOST_LIVERY } from "./boost.service";
import { PASS_THEMES } from "./pass.service";
import { SEASON_THEMES } from "./saison.service";

/* ============================================================
   2.4.2 : le nom de chaque livrée. Le sélecteur ne montrait que des carrés
   de couleur : impossible de savoir laquelle était la livrée d'Halloween ou
   celle de la saison. Toutes les sources de livrées sont nommées ici, avec
   leur provenance entre parenthèses quand elle aide à les reconnaître.
   ============================================================ */

const FIXED: [string, string][] = [
  // palette de base (création de compagnie)
  ["#c99a3e", "Ocre"],
  ["#4f7fa3", "Bleu acier"],
  ["#5c8a68", "Vert sauge"],
  ["#a8483a", "Rouge brique"],
  ["#8a6ba3", "Mauve"],
  ["#c97a3e", "Orange cuivré"],
  // palette Premium
  ["#0f766e", "Sarcelle (Premium)"],
  ["#b91c1c", "Rouge vif (Premium)"],
  ["#1e3a8a", "Bleu roi (Premium)"],
  ["#7c2d12", "Acajou (Premium)"],
  ["#4c1d95", "Violet profond (Premium)"],
  ["#065f46", "Vert forêt (Premium)"],
  ["#9d174d", "Framboise (Premium)"],
  ["#334155", "Gris ardoise (Premium)"],
  // boutique : les lots de quatre
  ["#2f4a3a", "Vert voiture-lit (époque)"],
  ["#6b1f2a", "Bordeaux (époque)"],
  ["#1f3b73", "Bleu Mistral (époque)"],
  ["#d8cfa8", "Crème (époque)"],
  ["#e0561b", "Orange signal (vives)"],
  ["#d4a017", "Or (vives)"],
  ["#2f9e6a", "Émeraude (vives)"],
  ["#7a3f9e", "Violet (vives)"],
  ["#1d4e89", "Bleu Bretagne (régionales)"],
  ["#b3261e", "Rouge Alsace (régionales)"],
  ["#8a79b8", "Lavande de Provence (régionales)"],
  ["#3f7d3a", "Vert Normandie (régionales)"],
  // boutique : coffrets et éditions limitées
  ["#6b1f3a", "Lie-de-vin (Vendanges)"],
  ["#1f4d3a", "Vert sapin (Noël)"],
  ["#c9d9e6", "Blanc glacier (Neiges)"],
  ["#e0a526", "Jaune soleil (Été)"],
  ["#8a4b1f", "Feuille morte (Toussaint)"],
  ["#1b1f3b", "Minuit pailleté (Nouvel An)"],
  ["#b23a48", "Rouge passion (Saint-Valentin)"],
  ["#5b1e2d", "Bordeaux impérial (Belle Époque)"],
  ["#c4ccd4", "Argent (Grande Vitesse)"],
  ["#7a1f2b", "Bordeaux (alliance)"],
  ["#0f4c5c", "Bleu pétrole (alliance)"],
  ["#3d2b56", "Violet nuit (alliance)"],
  // cadeaux et événements
  [V2_GIFT_LIVERY, "Bleu lancement (cadeau 2.0)"],
  [LEGEND_LIVERY, "Vert vapeur (Trains de légende)"],
  [CORSICA_LIVERY, "Maquis (Corse)"],
  [DISCORD_LIVERY, "Salon Discord"],
  [SPECTRAL_LIVERY, "Spectrale (Halloween)"],
  [BOOST_LIVERY, "Nitro (boost Discord)"],
];

// les deux palettes affichées à tous dans le sélecteur
export const BASE_LIVERIES = FIXED.slice(0, 14).map(([c]) => c);

let cache: Map<string, string> | null = null;

function build() {
  const m = new Map<string, string>();
  const put = (color: string, name: string) => {
    const k = color.toLowerCase();
    if (!m.has(k)) m.set(k, name);
  };
  for (const [c, n] of FIXED) put(c, n);
  for (const [, n, c] of SINGLE_LIVERIES) put(c, n);
  for (const t of Object.values(SEASON_THEMES)) put(t.livery, `${t.liveryName} (saison)`);
  for (const t of Object.values(PASS_THEMES)) {
    for (const l of t.liveries) put(l.color, `${l.name} (pass)`);
    put(t.final.color, `${t.final.name} (pass)`);
  }
  return m;
}

/* Les noms des couleurs demandées (en minuscules), celles qu'on ne connaît pas en moins. */
export function liveryNames(colors: Iterable<string>): Record<string, string> {
  if (!cache) cache = build();
  const out: Record<string, string> = {};
  for (const c of colors) {
    const n = cache.get(c.toLowerCase());
    if (n) out[c.toLowerCase()] = n;
  }
  return out;
}
