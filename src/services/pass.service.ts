import { prisma } from "../prisma";
import { currentSeason, themeOf } from "./saison.service";

/* ============================================================
   Le Pass de saison (2.0).

   Chaque saison de quatre semaines a son pass : vingt paliers franchis avec
   les points de saison que l'on gagne déjà en jouant. Deux parcours :

   - GRATUIT, pour tout le monde : des pièces tous les trois paliers.
   - LE PASS (2,99 €, une fois par saison) : une livrée, un emblème, des
     titres, une plaque, et la livrée et le titre de légende au bout.

   Ce que le pass débloque est cosmétique, gardé pour toujours, et ne se
   vend jamais en boutique : on ne l'a qu'en jouant la saison. Les pièces
   du parcours gratuit sont les mêmes pour tout le monde, payant ou non —
   le pass n'achète aucune avance.

   On peut acheter le pass à tout moment de la saison : les paliers déjà
   franchis sont débloqués d'un coup.
   ============================================================ */

export const PASS_TIERS = 30;
export const PASS_PRICE_CENTS = 299;
/* points de saison cumulés pour atteindre le palier n : 408 pour le premier,
   11 200 pour le 20e, 19 200 pour le 30e. Une petite compagnie atteint le
   20e palier dans la saison ; les dix derniers sont pour les plus assidus. */
export const tierThreshold = (n: number) => 400 * n + 8 * n * n;

export function tierOf(points: number) {
  let n = 0;
  while (n < PASS_TIERS && points >= tierThreshold(n + 1)) n++;
  return n;
}

// le parcours gratuit : des pièces tous les trois paliers
const FREE_COINS: Record<number, number> = { 3: 300, 6: 400, 9: 500, 12: 600, 15: 800, 18: 1000, 21: 1200, 24: 1400, 27: 1600, 30: 3000 };

interface PassTheme {
  liveries: { color: string; name: string }[]; // huit livrées, du palier 1 au 25
  emblems: { id: string; name: string }[]; // deux emblèmes
  titles: string[]; // six titres
  final: { color: string; name: string; title: string };
}

const PASS_THEMES: Record<string, PassTheme> = {
  automne: {
    liveries: [
      { color: "#8c3b1f", name: "Rouille" },
      { color: "#c2762e", name: "Cuivre" },
      { color: "#6b4423", name: "Châtaigne" },
      { color: "#a3542b", name: "Brique" },
      { color: "#7d6b2e", name: "Mousse" },
      { color: "#4b2e3e", name: "Mûre" },
      { color: "#b08a4a", name: "Paille" },
      { color: "#5c3a21", name: "Noyer" },
    ],
    emblems: [
      { id: "feuille", name: "Feuille d'érable" },
      { id: "gland", name: "Gland de chêne" },
    ],
    titles: ["Habitué d'automne", "Voyageur des vendanges", "Chef de quai d'automne", "Gardien des feuilles", "Maître des brumes", "Seigneur des forêts"],
    final: { color: "#d4a017", name: "Or d'automne", title: "Légende de l'automne" },
  },
  hiver: {
    liveries: [
      { color: "#2f4f6f", name: "Nuit polaire" },
      { color: "#7fa8c4", name: "Glacier" },
      { color: "#dfe7ee", name: "Neige fraîche" },
      { color: "#5a6f80", name: "Ardoise" },
      { color: "#1f3a4d", name: "Sapin de nuit" },
      { color: "#8d2f3a", name: "Vin chaud" },
      { color: "#a9b8c6", name: "Brume givrée" },
      { color: "#3d2c4f", name: "Aurore" },
    ],
    emblems: [
      { id: "givre", name: "Cristal de givre" },
      { id: "etoile-polaire", name: "Étoile polaire" },
    ],
    titles: ["Habitué de l'hiver", "Voyageur des neiges", "Chef de quai de l'hiver", "Gardien des cols", "Maître du verglas", "Seigneur des glaces"],
    final: { color: "#c7d6e2", name: "Argent givré", title: "Légende de l'hiver" },
  },
  printemps: {
    liveries: [
      { color: "#6fae6b", name: "Pousse" },
      { color: "#e3a5b5", name: "Cerisier" },
      { color: "#3f7d6a", name: "Sous-bois" },
      { color: "#c9b44a", name: "Colza" },
      { color: "#7aa6c9", name: "Ciel d'avril" },
      { color: "#b6d38a", name: "Tilleul" },
      { color: "#8a5a9e", name: "Iris" },
      { color: "#d97a5a", name: "Coquelicot" },
    ],
    emblems: [
      { id: "fleur", name: "Fleur de cerisier" },
      { id: "papillon", name: "Papillon" },
    ],
    titles: ["Habitué du printemps", "Voyageur des prairies", "Chef de quai du printemps", "Gardien des vergers", "Maître des giboulées", "Seigneur des jardins"],
    final: { color: "#9b7fc0", name: "Lilas", title: "Légende du printemps" },
  },
  ete: {
    liveries: [
      { color: "#e8b33d", name: "Blé mûr" },
      { color: "#2a8fb5", name: "Méditerranée" },
      { color: "#d96b3b", name: "Terre cuite" },
      { color: "#4f9a74", name: "Pinède" },
      { color: "#f2e1b0", name: "Sable" },
      { color: "#1f5f8b", name: "Grand large" },
      { color: "#c94f6d", name: "Laurier-rose" },
      { color: "#7c9a3a", name: "Olivier" },
    ],
    emblems: [
      { id: "phare", name: "Phare" },
      { id: "vague", name: "Vague" },
    ],
    titles: ["Habitué de l'été", "Voyageur des plages", "Chef de quai de l'été", "Gardien des criques", "Maître des canicules", "Seigneur des côtes"],
    final: { color: "#f2c14e", name: "Soleil de juillet", title: "Légende de l'été" },
  },
};

export const PASS_PLATES = ["cuivre", "argent", "legende"];

export type PassReward =
  | { type: "LIVREE"; color: string; label: string }
  | { type: "EMBLEME"; id: string; label: string }
  | { type: "TITRE"; title: string; label: string }
  | { type: "PLAQUE"; id: string; label: string };

function themeKeyOf(season: { name: string }) {
  const t = themeOf(season);
  return (Object.entries(PASS_THEMES).find(([k]) => t.name.toLowerCase().includes(k === "ete" ? "été" : k))?.[0] ?? "automne") as keyof typeof PASS_THEMES;
}

/* Les récompenses du pass, palier par palier : tous les paliers qui ne
   donnent pas de pièces en donnent une, et le dernier donne les deux. */
export function passRewards(season: { name: string }): Record<number, PassReward> {
  const th = PASS_THEMES[themeKeyOf(season)];
  const L = (i: number): PassReward => ({ type: "LIVREE", color: th.liveries[i].color, label: `Livrée « ${th.liveries[i].name} »` });
  const T = (i: number): PassReward => ({ type: "TITRE", title: th.titles[i], label: `Titre « ${th.titles[i]} »` });
  const E = (i: number): PassReward => ({ type: "EMBLEME", id: th.emblems[i].id, label: `Emblème « ${th.emblems[i].name} »` });
  return {
    1: L(0),
    2: T(0),
    4: L(1),
    5: E(0),
    7: L(2),
    8: T(1),
    10: L(3),
    11: { type: "PLAQUE", id: "cuivre", label: "Plaque en cuivre martelé" },
    13: L(4),
    14: T(2),
    16: E(1),
    17: L(5),
    19: T(3),
    20: { type: "PLAQUE", id: "argent", label: "Plaque en argent poli" },
    22: L(6),
    23: T(4),
    25: L(7),
    26: T(5),
    28: { type: "LIVREE", color: th.final.color, label: `Livrée de légende « ${th.final.name} »` },
    29: { type: "PLAQUE", id: "legende", label: "Plaque de légende" },
    30: { type: "TITRE", title: th.final.title, label: `Titre « ${th.final.title} »` },
  };
}

export const passItemId = (seasonNumber: number) => `pass-s${seasonNumber}`;
export const passSeasonNumber = (itemId: string) => {
  const m = /^pass-s(\d+)$/.exec(itemId);
  return m ? Number(m[1]) : null;
};

/* Tout ce que les pass achetés d'une compagnie lui ont fait gagner, toutes
   saisons confondues : lu par la boutique pour autoriser livrées et titres. */
export async function passUnlocks(companyId: string) {
  const out = { liveries: [] as string[], emblems: [] as string[], titles: [] as string[], plates: [] as string[] };
  const bought = (await prisma.shopPurchase.findMany({ where: { companyId, itemId: { startsWith: "pass-s" } }, select: { itemId: true } })) as { itemId: string }[];
  for (const b of bought) {
    const n = passSeasonNumber(b.itemId);
    if (n === null) continue;
    const season = await prisma.season.findUnique({ where: { number: n } });
    if (!season) continue;
    const entry = await prisma.seasonEntry.findUnique({ where: { seasonId_companyId: { seasonId: season.id, companyId } } });
    const reached = tierOf(entry?.points ?? 0);
    for (const [tier, r] of Object.entries(passRewards(season))) {
      if (Number(tier) > reached) continue;
      if (r.type === "LIVREE") out.liveries.push(r.color);
      if (r.type === "EMBLEME") out.emblems.push(r.id);
      if (r.type === "TITRE") out.titles.push(r.title);
      if (r.type === "PLAQUE") out.plates.push(r.id);
    }
  }
  return out;
}

/* La vue du pass pour le joueur. */
export async function passView(companyId: string) {
  const season = await currentSeason();
  if (!season) return { season: null };
  const [entry, owned, claims] = await Promise.all([
    prisma.seasonEntry.findUnique({ where: { seasonId_companyId: { seasonId: season.id, companyId } } }),
    prisma.shopPurchase.findUnique({ where: { companyId_itemId: { companyId, itemId: passItemId(season.number) } } }),
    prisma.seasonPassClaim.findMany({ where: { seasonId: season.id, companyId }, select: { tier: true } }),
  ]);
  const points = entry?.points ?? 0;
  const reached = tierOf(points);
  const claimed = new Set((claims as { tier: number }[]).map((c) => c.tier));
  const rewards = passRewards(season);
  return {
    season: { id: season.id, number: season.number, name: season.name, endsAt: season.endsAt },
    itemId: passItemId(season.number),
    priceCents: PASS_PRICE_CENTS,
    owned: Boolean(owned),
    points,
    reached,
    next: reached < PASS_TIERS ? tierThreshold(reached + 1) : null,
    tiers: Array.from({ length: PASS_TIERS }, (_, i) => {
      const n = i + 1;
      return {
        tier: n,
        need: tierThreshold(n),
        reached: n <= reached,
        free: FREE_COINS[n] ? { coins: FREE_COINS[n], claimed: claimed.has(n) } : null,
        pass: rewards[n] ?? null,
      };
    }),
  };
}

/* Réclamer les pièces d'un palier gratuit franchi. */
export async function claimFreeTier(companyId: string, tier: number) {
  const season = await currentSeason();
  if (!season) return { status: 409, error: "Aucune saison en cours" } as const;
  const coins = FREE_COINS[tier];
  if (!coins) return { status: 400, error: "Ce palier ne donne pas de pièces" } as const;
  const entry = await prisma.seasonEntry.findUnique({ where: { seasonId_companyId: { seasonId: season.id, companyId } } });
  if (tierOf(entry?.points ?? 0) < tier) return { status: 409, error: "Palier pas encore atteint" } as const;
  const done = await prisma.seasonPassClaim.findUnique({ where: { seasonId_companyId_tier: { seasonId: season.id, companyId, tier } } });
  if (done) return { status: 409, error: "Palier déjà réclamé" } as const;
  try {
    await prisma.$transaction([
      prisma.seasonPassClaim.create({ data: { seasonId: season.id, companyId, tier } }),
      prisma.company.update({ where: { id: companyId }, data: { balance: { increment: coins } } }),
      prisma.transaction.create({ data: { companyId, type: "EVENEMENT", amount: coins, description: `Pass de saison : palier ${tier}` } }),
    ]);
  } catch {
    return { status: 409, error: "Palier déjà réclamé" } as const;
  }
  return { ok: true, coins } as const;
}

/* L'objet de boutique qui correspond au pass de la saison en cours. */
export async function currentPassItem() {
  const season = await currentSeason();
  if (!season) return null;
  return {
    id: passItemId(season.number),
    kind: "PASS" as const,
    name: `Pass ${season.name.toLowerCase().startsWith("saison") ? "de la " + season.name.toLowerCase() : season.name}`,
    description: "Trente paliers franchis en jouant la saison : neuf livrées, deux emblèmes, sept titres, trois plaques, jusqu'à la livrée et le titre de légende. Tout est gardé pour toujours.",
    priceCents: PASS_PRICE_CENTS,
  };
}
