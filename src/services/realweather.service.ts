import { prisma } from "../prisma";
import { STATIONS, stationLonLat } from "./geography.service";

/* ============================================================
   2.0 : la vraie météo, gare par gare.

   Toutes les 20 minutes, le serveur relève la météo de chaque gare auprès
   de l'Institut météorologique norvégien (MET Norway, api.met.no) : gratuit,
   utilisable par un jeu payant, à condition de citer la source (licence
   CC BY 4.0) et d'envoyer un User-Agent qui identifie le jeu.

   Chaque rame subit ensuite la météo de sa ligne : la pire rencontrée sur
   son itinéraire (un orage à Lyon ralentit Paris–Marseille). Les épisodes
   inventés qui touchaient tout le réseau d'un coup ont disparu.
   ============================================================ */

export type WeatherKind = "CLAIR" | "NUAGEUX" | "PLUIE" | "ORAGE" | "NEIGE" | "VERGLAS" | "BROUILLARD" | "CANICULE";

export interface StationWeather {
  station: string;
  kind: WeatherKind;
  symbol: string;
  temp: number;
  wind: number; // m/s
  isDay: boolean;
  updatedAt: Date;
}

/* Ce que la météo fait aux rames.
   incident : multiplicateur du risque de retard
   slow     : chance, à chaque tour, que la rame n'avance pas
   wear     : multiplicateur de l'usure */
export const WEATHER_EFFECTS: Record<WeatherKind, { incident: number; slow: number; wear: number; effect: string | null; label: string }> = {
  CLAIR: { incident: 1, slow: 0, wear: 1, effect: null, label: "Temps clair" },
  NUAGEUX: { incident: 1, slow: 0, wear: 1, effect: null, label: "Nuageux" },
  PLUIE: { incident: 1.3, slow: 0.08, wear: 1, effect: "retards un peu plus fréquents", label: "Pluie" },
  ORAGE: { incident: 1.8, slow: 0.25, wear: 1.1, effect: "trains ralentis, retards fréquents", label: "Orage" },
  NEIGE: { incident: 1.5, slow: 0.3, wear: 1.1, effect: "trains ralentis, retards plus fréquents", label: "Neige" },
  VERGLAS: { incident: 2, slow: 0.15, wear: 1, effect: "risque de retard doublé", label: "Verglas" },
  BROUILLARD: { incident: 1.1, slow: 0.3, wear: 1, effect: "trains ralentis", label: "Brouillard" },
  CANICULE: { incident: 1, slow: 0, wear: 1.5, effect: "usure du matériel ×1,5", label: "Canicule" },
};

// la pire météo l'emporte sur un itinéraire
const SEVERITY: Record<WeatherKind, number> = { CLAIR: 0, NUAGEUX: 1, PLUIE: 2, CANICULE: 3, BROUILLARD: 3, NEIGE: 4, VERGLAS: 5, ORAGE: 6 };

const REFRESH_MS = 20 * 60_000;
const STALE_MS = 3 * 3_600_000; // au-delà, une valeur trop vieille ne compte plus
const CANICULE_FROM = 32; // °C

/* Le code de MET Norway (« lightrain_showers_day », « fog », « heavysnow »…)
   ramené aux huit temps du jeu, avec la température pour trancher. */
export function kindOf(symbol: string, temp: number, humidity = 0): WeatherKind {
  const s = symbol.replace(/_(day|night|polartwilight)$/, "");
  if (s.includes("thunder")) return "ORAGE";
  if (s.includes("snow")) return temp >= 2 && !s.includes("heavy") ? "PLUIE" : "NEIGE";
  if (s.includes("sleet")) return temp <= 1 ? "VERGLAS" : "PLUIE";
  if (s.includes("rain")) return temp <= 0 ? "VERGLAS" : "PLUIE";
  if (s === "fog") return "BROUILLARD";
  if (temp >= CANICULE_FROM) return "CANICULE";
  // gelée blanche : ciel clair, air humide sous zéro
  if (temp <= -1 && humidity >= 85) return "VERGLAS";
  if (s === "cloudy" || s === "partlycloudy") return "NUAGEUX";
  return "CLAIR";
}

const UA = `ReseauLeJeu/2.0 ${process.env.WEATHER_CONTACT || "https://compagnie.skhost.fr"}`;

async function fetchStation(name: string): Promise<Omit<StationWeather, "updatedAt"> | null> {
  const ll = stationLonLat(name);
  if (!ll) return null;
  // l'API demande au plus quatre décimales
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${ll.lat.toFixed(3)}&lon=${ll.lon.toFixed(3)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) return null;
    const data = (await r.json()) as any;
    // l'entrée de l'heure en cours (la première peut dater d'une heure plus tôt)
    const series = (data?.properties?.timeseries ?? []) as { time: string; data: any }[];
    const t = Date.now();
    const cur = series.filter((e) => new Date(e.time).getTime() <= t).pop() ?? series[0];
    const now = cur?.data;
    const d = now?.instant?.details ?? {};
    const symbol: string = now?.next_1_hours?.summary?.symbol_code ?? now?.next_6_hours?.summary?.symbol_code ?? "cloudy";
    const temp = Number(d.air_temperature ?? 12);
    return {
      station: name,
      kind: kindOf(symbol, temp, Number(d.relative_humidity ?? 0)),
      symbol,
      temp,
      wind: Number(d.wind_speed ?? 0),
      isDay: !/_night$|_polartwilight$/.test(symbol),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let lastRefresh = 0;
let refreshing = false;

/* Relevé de toutes les gares, cinq à la fois. Une gare qui ne répond pas
   garde sa dernière valeur. */
export async function refreshWeather(now = Date.now(), fetcher = fetchStation) {
  if (refreshing || now - lastRefresh < REFRESH_MS) return 0;
  refreshing = true;
  lastRefresh = now;
  let ok = 0;
  try {
    const queue = [...STATIONS];
    const worker = async () => {
      for (let name = queue.shift(); name; name = queue.shift()) {
        const w = await fetcher(name);
        if (!w) continue;
        ok++;
        const data = { kind: w.kind, symbol: w.symbol, temp: w.temp, wind: w.wind, isDay: w.isDay, updatedAt: new Date(now) };
        await prisma.stationWeather.upsert({ where: { station: name }, update: data, create: { station: name, ...data } });
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    cache = null;
  } finally {
    refreshing = false;
  }
  return ok;
}

let cache: { at: number; map: Map<string, StationWeather> } | null = null;

/* La météo de toutes les gares, relue au plus une fois par minute. */
export async function weatherMap(now = Date.now()): Promise<Map<string, StationWeather>> {
  if (cache && now - cache.at < 60_000) return cache.map;
  const rows = (await prisma.stationWeather.findMany()) as StationWeather[];
  const map = new Map<string, StationWeather>();
  for (const r of rows) if (now - new Date(r.updatedAt).getTime() < STALE_MS) map.set(r.station, r);
  cache = { at: now, map };
  return map;
}

/* La météo qu'une rame subit : la pire de son itinéraire. */
export function routeWeather(map: Map<string, StationWeather>, stations: string[]) {
  let worst: StationWeather | null = null;
  for (const st of stations) {
    const w = map.get(st);
    if (w && (!worst || SEVERITY[w.kind] > SEVERITY[worst.kind])) worst = w;
  }
  const kind: WeatherKind = worst?.kind ?? "CLAIR";
  return { kind, at: worst?.station ?? null, ...WEATHER_EFFECTS[kind] };
}

/* Pour l'affichage : la météo de chaque gare, et ce qu'elle change. */
export async function weatherView() {
  const map = await weatherMap();
  const stations: Record<string, { kind: WeatherKind; label: string; effect: string | null; temp: number; wind: number; isDay: boolean }> = {};
  let updatedAt: Date | null = null;
  for (const [name, w] of map) {
    stations[name] = { kind: w.kind, label: WEATHER_EFFECTS[w.kind].label, effect: WEATHER_EFFECTS[w.kind].effect, temp: Math.round(w.temp), wind: Math.round(w.wind * 3.6), isDay: w.isDay };
    if (!updatedAt || w.updatedAt > updatedAt) updatedAt = w.updatedAt;
  }
  return { stations, updatedAt, source: "MET Norway" };
}

/* Les gares où il se passe quelque chose, pour la Gazette. */
export async function severeWeather() {
  const map = await weatherMap();
  const out = new Map<WeatherKind, string[]>();
  for (const [name, w] of map) {
    if (SEVERITY[w.kind] < 3) continue;
    out.set(w.kind, [...(out.get(w.kind) ?? []), name]);
  }
  return out;
}
