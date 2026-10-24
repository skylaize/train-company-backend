import { ORGANS, Organ } from "./workshop.service";

/* ============================================================
   Le conteneur scellé (2.3).

   Un contrat au contenu inconnu, payé à prix d'or. On ne découvre ce qu'il y
   avait dedans qu'à la livraison : souvent rien de spécial, parfois un trésor,
   parfois des ennuis. En moyenne, il rapporte un peu plus qu'un conteneur
   ordinaire sur la même distance (environ 2,4 fois) ; c'est un pari, pas une
   arnaque.

   Le résultat est noté sur le contrat (sealedOutcome = "CODE|ce qu'il y avait"),
   lu par la Gazette et par la page du fret.
   ============================================================ */

export type SealedCode = "ORDINAIRE" | "TRESOR" | "PIECES" | "CASSE" | "SAISIE";

export interface SealedOutcome {
  code: SealedCode;
  what: string; // ce qu'il y avait dedans, en minuscules, avec l'article
  factor: number; // multiplicateur de la récompense
  wear: number; // usure ajoutée à la rame
  part?: Organ; // pièce détachée gagnée
  fineRatio?: number; // amende, en part de la récompense
  reputation?: number;
}

const pick = <T,>(xs: T[], r = Math.random) => xs[Math.floor(r() * xs.length)];

const ORDINARY = ["des rouleaux de tissu", "des pièces pour l'industrie automobile", "du matériel de bureau", "des sacs de ciment", "des pneus neufs", "des cartons de livres scolaires"];
const TREASURES = ["une cargaison de grands crus", "une voiture de collection", "un piano à queue de concert", "des truffes du Périgord", "les décors d'un opéra", "une collection de pièces anciennes"];
const BROKEN = ["de la vaisselle mal emballée", "des bocaux de confiture, en miettes", "des lustres en cristal, mal calés"];

/* Les chances : 45 % ordinaire, 20 % trésor, 15 % pièces détachées,
   12 % casse, 8 % saisie. */
export function openContainer(r: () => number = Math.random): SealedOutcome {
  const x = r();
  if (x < 0.45) return { code: "ORDINAIRE", what: pick(ORDINARY, r), factor: 1, wear: 0 };
  if (x < 0.65) return { code: "TRESOR", what: pick(TREASURES, r), factor: 2.5, wear: 0 };
  if (x < 0.8) {
    const part = pick([...ORGANS], r) as Organ;
    return { code: "PIECES", what: "des pièces détachées de rame, neuves", factor: 1, wear: 0, part };
  }
  if (x < 0.92) return { code: "CASSE", what: pick(BROKEN, r), factor: 0.3, wear: 15 };
  return { code: "SAISIE", what: "de la contrebande, saisie par la douane", factor: 0, wear: 0, fineRatio: 0.1, reputation: -1 };
}

export function outcomeText(o: SealedOutcome) {
  switch (o.code) {
    case "TRESOR":
      return `Jackpot : ${o.what} ! Le destinataire paie le prix fort.`;
    case "PIECES":
      return `${o.what.charAt(0).toUpperCase()}${o.what.slice(1)} : une pièce rejoint votre magasin.`;
    case "CASSE":
      return `${o.what.charAt(0).toUpperCase()}${o.what.slice(1)} : le client ne paie que les morceaux, et la rame a souffert.`;
    case "SAISIE":
      return "De la contrebande : la douane saisit tout, et vous paierez une amende.";
    default:
      return `${o.what.charAt(0).toUpperCase()}${o.what.slice(1)}. Rien de spécial, mais le prix était bon.`;
  }
}
