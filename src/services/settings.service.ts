import { prisma } from "../prisma";

/* ============================================================
   2.4 : réglages du jeu, modifiables depuis le panneau d'administration.

   Les taux de la 2.4 (gazole, électricité, carbone, pièces, voies,
   centrales) ne sont pas gravés dans le code : ils vivent dans la table
   GameSetting, sous la clé "economy", et l'admin les règle sans
   redéployer. Le code ne garde que les valeurs par défaut.

   Lecture synchrone : la simulation en a besoin des milliers de fois par
   tour. La valeur est gardée en mémoire et relue au plus toutes les
   30 secondes (une modification depuis ce serveur est prise aussitôt).
   ============================================================ */

export const ECONOMY_DEFAULTS = {
  // ---- période d'essai : tout est calculé et affiché, rien n'est prélevé
  trialDays: 14,
  trialUntil: null as string | null, // posé au premier démarrage de la 2.4

  // ---- gazole
  dieselPerMinute: 1.5, // litres par minute de trajet thermique
  dieselBase: 1, // pi. le litre, prix de référence
  dieselMin: 0.6,
  dieselMax: 2,
  dieselShockChancePerHour: 1 / (24 * 14), // un choc toutes les deux semaines environ
  tankLiters: 5000,
  tankCost: 3000,
  maxTanks: 4,
  fixedDays: 7,
  fixedFee: 0.1, // 10 % de frais sur un contrat à prix fixe

  // ---- électricité
  kwhPerMinute: 3,
  tgvPowerFactor: 2,
  powerBase: 0.25, // pi. le kWh
  peakFactor: 1.6, // 7-9 h et 17-20 h
  nightFactor: 0.7, // 0-6 h
  summerNoonFactor: 0.7, // 11-15 h d'avril à septembre
  coldFactor: 1.4, // vague de froid (température moyenne du réseau sous 0 °C)
  gridBuyback: 0.8, // le réseau rachète le surplus à 80 % de son prix
  outageChancePerHour: 1 / (24 * 5), // une panne de sous-station tous les cinq jours environ
  outageMinutes: 60,

  // ---- carbone
  co2PerLiter: 0.02 / 1.5, // 0,02 t par minute de trajet thermique
  co2PerGridKwh: 0.004 / 3, // 0,004 t par minute de trajet électrique au courant du réseau
  steamFactor: 2,
  weeklyQuota: 50,
  // tranches de valeur de la compagnie, et prix de la tonne dans chacune
  carbonBrackets: [
    { from: 0, rate: 0 },
    { from: 100_000, rate: 20 },
    { from: 1_000_000, rate: 60 },
    { from: 5_000_000, rate: 150 },
    { from: 20_000_000, rate: 300 },
  ] as { from: number; rate: number }[],

  // ---- pièces détachées
  partStock: 400, // stock national visé, par pièce
  partRestockPerHour: 0.05, // part du stock visé reconstituée chaque heure
  partMaxPriceFactor: 3,
  partMaxDelayFactor: 2,
  factoryCost: 25_000,
  factoryPerDay: 6,
  factoryStoreMax: 30,
  maxFactories: 3,

  // ---- voies
  trackWearPerTrip: 0.008, // points d'état perdus par trajet qui passe
  trackSlowFrom: 60,
  trackSlowFactor: 1.1,
  trackBadFrom: 30,
  trackBadFactor: 1.25,
  trackBadIncidents: 2,
  renovationPerKm: 25, // pi. par km et par point d'état à refaire, pour 100 points
  cofunderShare: 0.2, // part du chantier qui fait de vous un co-financeur
  cofunderBonus: 0.03,
  cofunderDays: 30,
  concessionPerKm: 60,
  maxConcessions: 5,
  maxToll: 0.15,
  concessionMinCondition: 50,
  concessionGraceHours: 72,
  concessionProtectionHours: 72,
  concessionBuyout: 1.5,
  concessionPayout: 1.25,

  // ---- centrales
  plants: {
    SOLAIRE: { cost: 8000, kwh: 400 },
    EOLIEN: { cost: 12000, kwh: 800 },
    BARRAGE: { cost: 60000, kwh: 1500 },
    BATTERIE: { cost: 10000, kwh: 3000 }, // capacité de stockage
  } as Record<string, { cost: number; kwh: number }>,
  maxPlants: 8,
};

export type EconomySettings = typeof ECONOMY_DEFAULTS;

const KEY = "economy";
const REFRESH_MS = 30_000;
let current: EconomySettings = structuredClone(ECONOMY_DEFAULTS);
let loadedAt = 0;
let loading: Promise<void> | null = null;

function merge(base: EconomySettings, patch: unknown): EconomySettings {
  if (!patch || typeof patch !== "object") return base;
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue; // une clé disparue du code est ignorée
    const def = (ECONOMY_DEFAULTS as Record<string, unknown>)[k];
    if (Array.isArray(def)) {
      if (Array.isArray(v)) out[k] = v;
    } else if (def && typeof def === "object") {
      out[k] = { ...(def as object), ...((v as object) ?? {}) };
    } else if (typeof def === "number") {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out as EconomySettings;
}

async function reload() {
  try {
    const row = await prisma.gameSetting.findUnique({ where: { key: KEY } });
    current = merge(ECONOMY_DEFAULTS, row?.value);
    loadedAt = Date.now();
  } catch (err) {
    // table absente (migration pas encore jouée) : valeurs par défaut, on réessaiera
    console.error("[réglages] lecture :", (err as Error).message);
    loadedAt = Date.now() - REFRESH_MS + 10_000;
  } finally {
    loading = null;
  }
}

/* Les réglages du moment. Ne bloque jamais : la relecture se fait en arrière-plan. */
export function economy(): EconomySettings {
  if (Date.now() - loadedAt > REFRESH_MS && !loading) loading = reload();
  return current;
}

export async function loadEconomy() {
  if (!loading) loading = reload();
  await loading;
  return current;
}

/* L'admin modifie un ou plusieurs réglages ; le reste est gardé. */
export async function updateEconomy(patch: Partial<Record<keyof EconomySettings, unknown>>) {
  await loadEconomy();
  const row = await prisma.gameSetting.findUnique({ where: { key: KEY } });
  const stored = { ...((row?.value as object) ?? {}), ...patch };
  await prisma.gameSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: stored as object }, update: { value: stored as object } });
  current = merge(ECONOMY_DEFAULTS, stored);
  loadedAt = Date.now();
  return current;
}

/* La période d'essai démarre au premier tour de simulation de la 2.4. */
export async function ensureTrialStart(now = new Date()) {
  const s = await loadEconomy();
  if (s.trialUntil) return s;
  return updateEconomy({ trialUntil: new Date(now.getTime() + s.trialDays * 86_400_000).toISOString() });
}

export function inTrial(now = Date.now()) {
  const until = economy().trialUntil;
  return Boolean(until && now < new Date(until).getTime());
}
