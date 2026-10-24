/* ============================================================
   Fret et wagons (2.1).

   Le fret a sa catégorie de matériel : quatre locomotives, et des wagons
   typés qu'on leur attelle. Les rames voyageurs ne livrent plus de fret.

   - plusieurs wagons du même type portent plus : le contrat paie plus
     (×1 avec un wagon, ×1,6 avec deux, ×2,1 avec trois…) ;
   - des wagons de types différents permettent de prendre plusieurs contrats
     d'un coup, un par type : la rame part en tournée. La tournée dure le
     plus long des trajets plus la moitié des autres, et chaque contrat est
     payé à l'arrivée.
   ============================================================ */

export type WagonId = "W_TREMIE" | "W_PLAT" | "W_CONTENEUR" | "W_PORTE_AUTOS" | "W_CITERNE" | "W_CAPITONNE" | "W_FRIGO";

export const WAGONS: Record<WagonId, { label: string; short: string; cargos: string[]; price: number }> = {
  W_TREMIE: { label: "Wagon-trémie", short: "Trémie", cargos: ["Céréales"], price: 140 },
  W_PLAT: { label: "Wagon plat", short: "Plat", cargos: ["Acier", "Bois"], price: 120 },
  W_CONTENEUR: { label: "Wagon porte-conteneurs", short: "Conteneurs", cargos: ["Conteneurs", "Conteneur scellé"], price: 150 }, // 2.3 : le conteneur scellé voyage sur le même wagon
  W_PORTE_AUTOS: { label: "Wagon porte-autos", short: "Porte-autos", cargos: ["Automobiles"], price: 190 },
  W_CITERNE: { label: "Wagon-citerne", short: "Citerne", cargos: ["Produits chimiques"], price: 180 },
  W_CAPITONNE: { label: "Wagon couvert capitonné", short: "Capitonné", cargos: ["Verre soufflé", "Œuvres d'art"], price: 220 },
  W_FRIGO: { label: "Wagon frigorifique", short: "Frigo", cargos: ["Produits pharmaceutiques réfrigérés"], price: 240 },
};

/* Les locomotives de fret : combien de wagons, à quelle allure (durée ×,
   alourdie de 4 % par wagon au-delà du premier) et leur bonus de paie. */
export const FREIGHT_MODELS: Record<string, { label: string; maxWagons: number; pace: number; bonus: number }> = {
  LOCOTRACTEUR: { label: "Locotracteur", maxWagons: 2, pace: 1.15, bonus: 1 },
  FRET_LOURD: { label: "Fret lourd", maxWagons: 4, pace: 1.1, bonus: 1.1 },
  FRET_RAPIDE: { label: "Messagerie rapide", maxWagons: 3, pace: 0.7, bonus: 1.15 },
  FRET_ELECTRIQUE: { label: "Électrique longue distance", maxWagons: 5, pace: 0.9, bonus: 1.2 },
};
export const WAGON_DRAG = 0.04;

// charge portée selon le nombre de wagons du même type
export const LOAD_FACTOR = [0, 1, 1.6, 2.1, 2.5, 2.8, 3];

export const isWagon = (id: string): id is WagonId => id in WAGONS;
export const isFreightModel = (model: string) => model in FREIGHT_MODELS;
// 2.1 : toutes les locomotives de fret sont réservées au fret
export const freightOnly = (model: string) => isFreightModel(model);

export function wagonFor(cargoType: string): WagonId | null {
  for (const [id, w] of Object.entries(WAGONS)) if (w.cargos.includes(cargoType)) return id as WagonId;
  return null;
}

export function wagonsOf(cars: string[] | null | undefined) {
  const count = new Map<WagonId, number>();
  for (const c of cars ?? []) if (isWagon(c)) count.set(c, (count.get(c) ?? 0) + 1);
  return count;
}

/* Ce qu'une rame peut charger : null si elle peut, sinon la raison. */
export function loadCheck(train: { model: string; cars?: string[] | null }, cargoTypes: string[]): string | null {
  if (!isFreightModel(train.model)) return "Le fret se livre avec une locomotive de fret : les rames voyageurs n'en prennent plus";
  const wagons = wagonsOf(train.cars);
  if (wagons.size === 0) return "Attelez au moins un wagon à cette locomotive";
  const used = new Set<WagonId>();
  for (const cargo of cargoTypes) {
    const w = wagonFor(cargo);
    if (!w || !wagons.has(w)) return `Il faut un ${w ? WAGONS[w].label.toLowerCase() : "wagon adapté"} pour transporter : ${cargo.toLowerCase()}`;
    if (used.has(w)) return `Un seul contrat par type de wagon : deux cargaisons demandent un ${WAGONS[w].label.toLowerCase()}`;
    used.add(w);
  }
  return null;
}

/* Le multiplicateur de charge d'une cargaison sur cette rame. */
export function loadFactorFor(train: { cars?: string[] | null }, cargoType: string) {
  const w = wagonFor(cargoType);
  const n = w ? wagonsOf(train.cars).get(w) ?? 0 : 0;
  return n > 0 ? LOAD_FACTOR[Math.min(n, LOAD_FACTOR.length - 1)] : 1;
}

/* Durée d'une tournée : le plus long trajet, plus la moitié des autres, à l'allure de la rame. */
export function tourMinutes(model: string, durations: number[], wagonCount = 1) {
  if (durations.length === 0) return 0;
  const sorted = [...durations].sort((a, b) => b - a);
  const raw = sorted[0] + sorted.slice(1).reduce((s, d) => s + d / 2, 0);
  const pace = (FREIGHT_MODELS[model]?.pace ?? 1) * (1 + WAGON_DRAG * Math.max(0, wagonCount - 1));
  return Math.max(2, Math.round(raw * pace));
}

/* 2.1 : avant la 2.1, les rames voyageurs livraient du fret. Celles qui ont
   une livraison en cours la terminent ; elles n'en prennent plus de nouvelle. */

export const modelBonus = (model: string) => FREIGHT_MODELS[model]?.bonus ?? 1;
