import { prisma } from "../prisma";

/* ============================================================
   Lignes internationales (1.6).

   Six gares à l'étranger, placées sur la carte avec la même projection que
   les gares françaises. Pour y faire rouler ses rames, une compagnie achète
   une licence internationale : il faut un grade de Baron du rail et de quoi
   la payer. C'est une étape de carrière, pas un bonus de départ.

   Une ligne internationale rapporte nettement plus par trajet (clientèle
   d'affaires, billets plus chers), mais chaque trajet paie un péage de sillon
   au réseau étranger. Net, elle reste la meilleure ligne du jeu : c'est la
   récompense d'avoir grandi.

   Les abonnés Premium peuvent acheter la licence dès la mise en ligne de la
   1.6 ; tout le monde, une semaine plus tard.
   ============================================================ */

export const INTERNATIONAL_STATIONS: Record<string, { country: string; code: string }> = {
  Londres: { country: "Royaume-Uni", code: "GB" },
  Bruxelles: { country: "Belgique", code: "BE" },
  Francfort: { country: "Allemagne", code: "DE" },
  "Genève": { country: "Suisse", code: "CH" },
  Milan: { country: "Italie", code: "IT" },
  Barcelone: { country: "Espagne", code: "ES" },
  // 2.0 : ouvertes par le tunnel du Mont-Blanc
  Turin: { country: "Italie", code: "IT" },
  Zurich: { country: "Suisse", code: "CH" },
};

// les six gares de la 1.6, pour les succès et grades qui les comptent
export const FIRST_INTERNATIONAL = ["Londres", "Bruxelles", "Francfort", "Genève", "Milan", "Barcelone"];

export const LICENCE_COST = 6000;
export const LICENCE_MIN_GRADE = 3; // Baron du rail
export const INTL_REVENUE_BONUS = 1.6; // recette d'un trajet international, avant péage
export const TOLL_RATE = 0.25; // part de cette recette reversée au réseau étranger
const PREMIUM_HEAD_START_MS = 7 * 86_400_000;
const MIGRATION = "20260927190000_v1_6_international_nuit";

export function isInternational(station: string) {
  return Object.prototype.hasOwnProperty.call(INTERNATIONAL_STATIONS, station);
}

export function lineIsInternational(a: string, b: string) {
  return isInternational(a) || isInternational(b);
}

/* Date d'ouverture à tous : une semaine après la mise en ligne de la 1.6,
   lue sur la migration qui l'a installée. Rien à régler à la main. */
let openCache: { at: number; value: Date | null } | null = null;
export async function publicOpeningDate(): Promise<Date | null> {
  if (openCache && Date.now() - openCache.at < 3_600_000) return openCache.value;
  let value: Date | null = null;
  try {
    const rows = (await prisma.$queryRaw`SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = ${MIGRATION} LIMIT 1`) as { finished_at: Date | null }[];
    const done = rows[0]?.finished_at;
    value = done ? new Date(new Date(done).getTime() + PREMIUM_HEAD_START_MS) : null;
  } catch {
    value = null; // pas de table de migrations (base de test) : ouvert à tous
  }
  openCache = { at: Date.now(), value };
  return value;
}

export type LicenceView = {
  owned: boolean;
  cost: number;
  minGrade: number;
  gradeOk: boolean;
  openToAllAt: string | null; // null : déjà ouverte à tous
  earlyAccess: boolean; // ouverte à cette compagnie grâce au Premium
  canBuy: boolean;
  reason: string | null;
};

export async function licenceView(
  company: { intlLicenceAt: Date | null; isPremium: boolean; balance: number },
  gradeId: number,
  now = new Date()
): Promise<LicenceView> {
  const opening = await publicOpeningDate();
  const openToAll = !opening || opening <= now;
  const open = openToAll || company.isPremium;
  const gradeOk = gradeId >= LICENCE_MIN_GRADE;
  const owned = company.intlLicenceAt != null;
  let reason: string | null = null;
  if (owned) reason = null;
  else if (!open) reason = "Réservée aux abonnés Premium jusqu'à l'ouverture à tous";
  else if (!gradeOk) reason = "Il faut le grade « Baron du rail »";
  else if (company.balance < LICENCE_COST) reason = `Il faut ${LICENCE_COST} pi. en trésorerie`;
  return {
    owned,
    cost: LICENCE_COST,
    minGrade: LICENCE_MIN_GRADE,
    gradeOk,
    openToAllAt: openToAll ? null : opening!.toISOString(),
    earlyAccess: !openToAll && company.isPremium,
    canBuy: !owned && reason === null,
    reason,
  };
}
