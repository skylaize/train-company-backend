/* ============================================================
   Donneurs d'ordre.

   Chaque client est rattaché à des marchandises qui existent déjà dans
   CARGO_TEMPLATES (contract.controller.ts) : le système ne crée pas un
   second circuit économique à côté du fret, il donne une raison de
   préférer un contrat à un autre.

   La récompense de mission n'est pas le vrai enjeu. Le vrai enjeu est la
   réputation, qui majore le tarif de TOUTES les cargaisons du client —
   se spécialiser devient une stratégie, pas une collection de primes.
   ============================================================ */

export interface ClientDef {
  id: string;
  name: string;
  sector: string;
  city: string;
  cargoTypes: string[];
  /* Grade de carrière minimum. Les Laboratoires ne traitent qu'avec des
     compagnies établies : leurs cargaisons sont fragiles, confier ça à un
     débutant qui n'a pas de mécanicien serait absurde côté fiction, et
     décourageant côté jeu. */
  minGradeId: number;
  /* Deux teintes : un cyan pur tourne au laiteux sur le fond crème du thème
     papier, un vert encre disparaît sur le fond sombre. */
  color: string;
  colorPaper: string;
}

export const CLIENTS: ClientDef[] = [
  {
    id: "ACIERIES",
    name: "Aciéries de Lorraine",
    sector: "Industrie lourde",
    city: "Metz",
    cargoTypes: ["Acier", "Automobiles", "Bois"],
    minGradeId: 0,
    color: "#38bdf8",
    colorPaper: "#2d6a8c",
  },
  {
    id: "PORT",
    name: "Port autonome du Havre",
    sector: "Maritime",
    city: "Le Havre",
    cargoTypes: ["Conteneurs", "Céréales"],
    minGradeId: 0,
    color: "#10b981",
    colorPaper: "#1f5c4d",
  },
  {
    id: "COOPERATIVE",
    name: "Coopérative de la Beauce",
    sector: "Agricole",
    city: "Chartres",
    cargoTypes: ["Céréales", "Bois"],
    minGradeId: 1,
    color: "#f59e0b",
    colorPaper: "#9a6516",
  },
  {
    id: "LABORATOIRES",
    name: "Laboratoires du Rhône",
    sector: "Chimie et pharmacie",
    city: "Lyon",
    cargoTypes: ["Produits chimiques", "Produits pharmaceutiques réfrigérés", "Verre soufflé"],
    minGradeId: 2,
    color: "#a78bfa",
    colorPaper: "#6b4f8f",
  },
];

export function clientById(id: string) {
  return CLIENTS.find((c) => c.id === id) ?? null;
}

/* Paliers de fidélité. Le bonus s'applique au paiement de chaque cargaison
   du client, mission ou non. */
export const CLIENT_LEVELS = [
  { level: 0, from: 0, name: "Nouveau partenaire", bonus: 0 },
  { level: 1, from: 30, name: "Client régulier", bonus: 0.08 },
  { level: 2, from: 60, name: "Client privilégié", bonus: 0.15 },
  { level: 3, from: 100, name: "Affréteur historique", bonus: 0.25 },
];

export function levelFromReputation(reputation: number) {
  let found = CLIENT_LEVELS[0];
  for (const l of CLIENT_LEVELS) if (reputation >= l.from) found = l;
  return found;
}

export function nextLevel(reputation: number) {
  return CLIENT_LEVELS.find((l) => l.from > reputation) ?? null;
}

/* Majoration accordée à une cargaison donnée, tous clients confondus.
   Si deux clients achètent la même marchandise (les céréales intéressent le
   Port ET la Coopérative), c'est la meilleure relation qui s'applique :
   pénaliser le joueur parce qu'il a deux bons clients n'aurait aucun sens. */
export function cargoBonus(cargoType: string, reputationByClient: Map<string, number>) {
  let best = 0;
  for (const client of CLIENTS) {
    if (!client.cargoTypes.includes(cargoType)) continue;
    const rep = reputationByClient.get(client.id) ?? 0;
    best = Math.max(best, levelFromReputation(rep).bonus);
  }
  return best;
}

export const REPUTATION_MAX = 100;
export const FAILURE_PENALTY = 6; // réputation perdue quand un ordre n'est pas honoré
