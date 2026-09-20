import { prisma } from "../prisma";

/* ============================================================
   Cours du fret.

   Ce que ce système corrige : une trésorerie importante n'avait plus de
   destination. Une compagnie mûre encaissait 1 900 pi./h et regardait le
   chiffre monter, parce que tout ce qui s'achetait était déjà acheté.

   Ici, l'argent dormant devient du stock, et le stock peut perdre de la valeur.
   Thésauriser cesse d'être la stratégie sans risque : c'est un choix parmi
   d'autres, qui a un coût d'opportunité et une chance de se tromper.

   Trois garde-fous, sans lesquels ce ne serait qu'un distributeur :
   - un écart entre le prix d'achat et le prix de vente (on ne peut pas faire
     l'aller-retour à l'instant sans perdre) ;
   - des frais de garde proportionnels au stock (attendre coûte) ;
   - une capacité d'entrepôt limitée (on ne peut pas tout miser).
   ============================================================ */

/* Marchandises cotées. Ce sont exactement celles qui circulent déjà sur le
   marché du fret : introduire des marchandises « de bourse » sans rapport avec
   les contrats aurait fait deux jeux côte à côte au lieu d'un seul. */
export const TRADED_CARGO: { cargoType: string; basePrice: number; volatility: number }[] = [
  { cargoType: "Céréales", basePrice: 40, volatility: 1.3 },     // saisonnière, bouge beaucoup
  { cargoType: "Acier", basePrice: 60, volatility: 1.0 },
  { cargoType: "Conteneurs", basePrice: 30, volatility: 1.15 },
  { cargoType: "Bois", basePrice: 34, volatility: 0.85 },
  { cargoType: "Automobiles", basePrice: 50, volatility: 0.9 },
  { cargoType: "Produits chimiques", basePrice: 47, volatility: 1.1 },
  { cargoType: "Verre soufflé", basePrice: 77, volatility: 0.8 }, // marchandises fragiles : plus chères,
  { cargoType: "Œuvres d'art", basePrice: 113, volatility: 1.25 }, // cours plus nerveux pour les œuvres
  { cargoType: "Produits pharmaceutiques réfrigérés", basePrice: 63, volatility: 1.05 },
];

export const INDEX_MIN = 0.62;
export const INDEX_MAX = 1.48;

/* Retour à la moyenne : sans lui, une marche aléatoire finit par dériver et
   une marchandise resterait à son plancher pendant des jours. */
const MEAN_REVERSION = 0.018;
const NOISE = 0.011;

/* Écart entre achat et vente. 2 % de chaque côté : un aller-retour immédiat
   perd 4 %, donc il faut que le cours bouge vraiment pour gagner. */
export const SPREAD = 0.02;

/* Frais de garde, prélevés toutes les dix minutes de simulation.

   Exprimés en pourcentage de la VALEUR stockée et non en pièces par unité :
   une facture à l'unité rendait la garde négligeable (2,4 pi./h pour un lot de
   1 100 pi.) et remplir l'entrepôt devenait un réflexe sans arbitrage. À
   0,8 % par heure, un aller-retour de deux heures et demie coûte environ 2 %
   du capital engagé : rentable quand on choisit son moment, coûteux quand on
   garde un lot en espérant qu'il remonte. */
export const STORAGE_FEE_RATE_PER_HOUR = 0.008;

export function clampIndex(v: number) {
  return Math.max(INDEX_MIN, Math.min(INDEX_MAX, v));
}

export function buyPrice(basePrice: number, index: number) {
  return Math.max(1, Math.round(basePrice * index * (1 + SPREAD)));
}

export function sellPrice(basePrice: number, index: number) {
  return Math.max(1, Math.round(basePrice * index * (1 - SPREAD)));
}

/* Événements de marché. Ils donnent une RAISON au mouvement : un cours qui
   monte sans explication ressemble à un bug, le même mouvement annoncé par
   « grève au port » se lit comme une information à exploiter. */
const EVENTS: { cargoType: string; label: string; shock: number; hours: number }[] = [
  { cargoType: "Conteneurs", label: "Grève au port du Havre : le fret maritime s'engorge", shock: +0.26, hours: 5 },
  { cargoType: "Conteneurs", label: "Retour à la normale sur les quais du Havre", shock: -0.2, hours: 4 },
  { cargoType: "Céréales", label: "Récolte abondante en Beauce : les silos débordent", shock: -0.24, hours: 6 },
  { cargoType: "Céréales", label: "Sécheresse annoncée : les cours du grain s'emballent", shock: +0.28, hours: 6 },
  { cargoType: "Acier", label: "Commande publique de rails : l'acier est recherché", shock: +0.24, hours: 5 },
  { cargoType: "Acier", label: "Haut fourneau à l'arrêt en Lorraine : la demande retombe", shock: -0.22, hours: 5 },
  { cargoType: "Automobiles", label: "Salon de l'automobile : les usines expédient à plein", shock: +0.22, hours: 4 },
  { cargoType: "Bois", label: "Tempête dans les Vosges : bois d'abattage en abondance", shock: -0.26, hours: 6 },
  { cargoType: "Produits chimiques", label: "Norme de transport renforcée : l'offre se raréfie", shock: +0.2, hours: 5 },
  { cargoType: "Œuvres d'art", label: "Vente aux enchères à Drouot : les convois se multiplient", shock: +0.3, hours: 3 },
  { cargoType: "Verre soufflé", label: "Commande d'une cathédrale : la verrerie tourne", shock: +0.19, hours: 4 },
  { cargoType: "Produits pharmaceutiques réfrigérés", label: "Campagne de vaccination : chaîne du froid saturée", shock: +0.25, hours: 4 },
];

/* Probabilité qu'un événement se déclenche à un tick donné, tous produits
   confondus. À 0,4 %, avec un tick toutes les 30 secondes, cela fait un
   événement toutes les deux heures environ. */
const EVENT_CHANCE = 0.004;

const HISTORY_POINTS = 96; // 8 heures d'historique à un relevé toutes les 5 minutes
const HISTORY_EVERY_MS = 5 * 60_000;

type HistoryPoint = { t: number; i: number };

export function parseHistory(raw: string): HistoryPoint[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* Crée les lignes manquantes. Appelée au démarrage et à chaque tick : ajouter
   une marchandise au tableau ci-dessus suffit à la faire coter, sans migration. */
export async function ensureCargoMarkets() {
  const existing = await prisma.cargoMarket.findMany({ select: { cargoType: true } });
  const known = new Set(existing.map((e: { cargoType: string }) => e.cargoType));

  for (const cargo of TRADED_CARGO) {
    if (known.has(cargo.cargoType)) continue;
    /* On ne démarre pas tout le monde à 1 : sinon, au lancement, aucune
       marchandise n'est intéressante et la page paraît morte. */
    const start = clampIndex(1 + (Math.random() - 0.5) * 0.3);
    await prisma.cargoMarket.create({
      data: {
        cargoType: cargo.cargoType,
        basePrice: cargo.basePrice,
        index: start,
        history: JSON.stringify([{ t: Date.now(), i: Number(start.toFixed(4)) }]),
      },
    });
  }
}

/* Tirage gaussien approché : la somme de trois tirages uniformes donne une
   courbe bien plus crédible qu'un bruit uniforme, où les grands écarts sont
   aussi fréquents que les petits. */
function gaussian() {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 0.5;
}

export async function runMarketTick() {
  await ensureCargoMarkets();

  const markets = await prisma.cargoMarket.findMany();
  const now = Date.now();

  // un seul événement possible par tick, pour ne pas secouer tout le marché d'un coup
  let event: (typeof EVENTS)[number] | null = null;
  if (Math.random() < EVENT_CHANCE) {
    event = EVENTS[Math.floor(Math.random() * EVENTS.length)];
  }

  for (const m of markets as any[]) {
    const def = TRADED_CARGO.find((c) => c.cargoType === m.cargoType);
    const volatility = def?.volatility ?? 1;

    let index = m.index as number;
    index += MEAN_REVERSION * (1 - index);
    index += NOISE * volatility * gaussian();

    let eventLabel: string | null = m.eventLabel;
    let eventUntil: Date | null = m.eventUntil;

    if (event && event.cargoType === m.cargoType) {
      index += event.shock;
      eventLabel = event.label;
      eventUntil = new Date(now + event.hours * 3600_000);
    } else if (eventUntil && eventUntil.getTime() < now) {
      // l'événement est passé : le cours revient tout seul, par le retour à la moyenne
      eventLabel = null;
      eventUntil = null;
    }

    index = clampIndex(index);

    const history = parseHistory(m.history);
    const last = history[history.length - 1];
    const shouldRecord = !last || now - last.t >= HISTORY_EVERY_MS;
    const nextHistory = shouldRecord
      ? [...history, { t: now, i: Number(index.toFixed(4)) }].slice(-HISTORY_POINTS)
      : history;

    await prisma.cargoMarket.update({
      where: { cargoType: m.cargoType },
      data: {
        index,
        eventLabel,
        eventUntil,
        ...(shouldRecord ? { history: JSON.stringify(nextHistory) } : {}),
      },
    });
  }
}

/* Frais de garde. Prélevés toutes les dix minutes plutôt qu'à chaque tick :
   à 30 secondes, la somme due serait inférieure à la pièce et l'arrondi
   ramènerait la facture à zéro — le même piège que l'usure Premium. */
const STORAGE_EVERY_MS = 10 * 60_000;
let lastStorageRun = 0;

export async function runStorageFees() {
  const now = Date.now();
  if (now - lastStorageRun < STORAGE_EVERY_MS) return;
  const elapsedHours = lastStorageRun === 0 ? STORAGE_EVERY_MS / 3600_000 : (now - lastStorageRun) / 3600_000;
  lastStorageRun = now;

  const lots = await prisma.stockLot.findMany({ where: { quantity: { gt: 0 } } });

  /* La facture porte sur le prix de revient, pas sur le cours du jour : sinon
     un lot qui s'effondre coûterait moins cher à garder au moment précis où il
     fait le plus mal, ce qui serait exactement l'inverse du bon signal. */
  const byCompany = new Map<string, { units: number; value: number }>();
  for (const lot of lots as { companyId: string; quantity: number; avgUnitPrice: number }[]) {
    const entry = byCompany.get(lot.companyId) ?? { units: 0, value: 0 };
    entry.units += lot.quantity;
    entry.value += lot.quantity * lot.avgUnitPrice;
    byCompany.set(lot.companyId, entry);
  }

  for (const [companyId, { units, value }] of byCompany) {
    const fee = Math.round(value * STORAGE_FEE_RATE_PER_HOUR * elapsedHours);
    if (fee <= 0) continue;

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { balance: true } });
    if (!company) continue;

    /* Trésorerie insuffisante : on ne met pas la compagnie en négatif et on ne
       confisque pas le stock non plus. Les frais sautent, simplement — la
       sanction est déjà que l'argent est immobilisé. */
    if (company.balance < fee) continue;

    await prisma.$transaction([
      prisma.company.update({ where: { id: companyId }, data: { balance: { decrement: fee } } }),
      prisma.transaction.create({
        data: {
          companyId,
          type: "GARDE",
          amount: -fee,
          description: `Frais de garde de l'entrepôt (${units} unité${units > 1 ? "s" : ""})`,
        },
      }),
    ]);
  }
}

/* ============================================================
   Lien entre le cours et les trains.

   Sans ce lien, la page des cours serait un jeu à part, posé à côté du jeu
   ferroviaire. Ici, le cours module aussi ce que rapporte une LIVRAISON : il
   devient intéressant de regarder le tableau avant de choisir un contrat.

   L'effet est volontairement amorti de moitié. À pleine puissance, un cours au
   plancher amputerait une livraison de 38 % — un nouveau joueur, qui ne
   regarde pas encore les cours, aurait l'impression que ses recettes varient
   sans raison. Amorti, l'écart va de −19 % à +24 % : assez pour récompenser
   celui qui surveille, pas assez pour punir celui qui débute.
   ============================================================ */
export const FREIGHT_DAMPING = 0.5;

export function freightMultiplier(index: number) {
  return 1 + FREIGHT_DAMPING * (index - 1);
}

export async function getCargoIndexMap(): Promise<Map<string, number>> {
  const markets = await prisma.cargoMarket.findMany({ select: { cargoType: true, index: true } });
  return new Map((markets as { cargoType: string; index: number }[]).map((m) => [m.cargoType, m.index]));
}
