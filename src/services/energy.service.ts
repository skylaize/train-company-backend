import { prisma } from "../prisma";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { chunk, row, pool, SIM_CONCURRENCY } from "./batch.service";
import { economy, inTrial } from "./settings.service";
import { parisDate, parisHour } from "./time.service";
import { REGIONS, REGION_OF } from "./regions.service";
import type { StationWeather } from "./realweather.service";

/* ============================================================
   2.4 : l'énergie — gazole, électricité, centrales et batteries.

   - Chaque trajet consomme : des litres de gazole sur une ligne non
     électrifiée, des kWh sur une ligne électrifiée. La consommation est
     relevée au compteur de l'heure (EnergyMeter).
   - À la fin de chaque heure, la facture se règle : le courant produit par
     ses propres centrales d'abord, puis la batterie, puis le surplus des
     autres joueurs s'il est moins cher, puis le réseau. Le gazole vient de
     la cuve, puis de la pompe.
   - Le gazole et le courant ont un cours qui bouge chaque heure, avec des
     chocs de temps en temps ; le courant suit aussi l'heure de la journée
     et la vraie météo (vague de froid, soleil, vent).
   - Pendant la période d'essai, tout est calculé et affiché, rien n'est
     prélevé ni versé.
   ============================================================ */

export type PlantKind = "SOLAIRE" | "EOLIEN" | "BARRAGE" | "BATTERIE";
export const PLANT_KINDS: PlantKind[] = ["SOLAIRE", "EOLIEN", "BARRAGE", "BATTERIE"];
export const PLANT_LABELS: Record<PlantKind, string> = { SOLAIRE: "Parc solaire", EOLIEN: "Éoliennes", BARRAGE: "Barrage", BATTERIE: "Batterie" };

/* Où chaque centrale peut se construire. */
const SUN_REGIONS = ["occitanie", "paca", "nouvelle-aquitaine", "corse"];
const WIND_REGIONS = ["hdf", "normandie", "bretagne", "pdl", "nouvelle-aquitaine", "occitanie", "corse"];
const DAM_STATIONS = ["Grenoble", "Chamonix", "Bourg-Saint-Maurice", "Briançon", "Font-Romeu", "Pau", "Corte"];

export function plantSiteOk(kind: PlantKind, station: string) {
  if (kind === "BATTERIE") return true;
  if (kind === "BARRAGE") return DAM_STATIONS.includes(station);
  const region = REGION_OF[station];
  return kind === "SOLAIRE" ? SUN_REGIONS.includes(region) : WIND_REGIONS.includes(region);
}

export function plantSites(kind: PlantKind) {
  if (kind === "BARRAGE") return DAM_STATIONS;
  if (kind === "BATTERIE") return null; // partout
  const regions = kind === "SOLAIRE" ? SUN_REGIONS : WIND_REGIONS;
  return REGIONS.filter((r) => regions.includes(r.id)).flatMap((r) => r.stations);
}

/* ---------------- consommation d'un trajet ---------------- */

export interface Traction {
  electric: boolean;
  powerFactor: number; // la grande vitesse consomme le double
  steam: boolean;
}

export function tripEnergy(minutes: number, t: Traction) {
  const s = economy();
  if (t.electric) return { kwh: minutes * s.kwhPerMinute * t.powerFactor, liters: 0, co2: 0 };
  const liters = minutes * s.dieselPerMinute;
  return { kwh: 0, liters, co2: liters * s.co2PerLiter * (t.steam ? s.steamFactor : 1) };
}

/* Le compteur de l'heure : on additionne pendant le tour, on écrit une fois
   à la fin (une écriture par compagnie et par tour, pas une par trajet). */
type Reading = { kwh: number; liters: number; co2: number };
const pendingMeters = new Map<string, Reading>();

export function meterAdd(companyId: string, r: Partial<Reading>) {
  const m = pendingMeters.get(companyId) ?? { kwh: 0, liters: 0, co2: 0 };
  m.kwh += r.kwh ?? 0;
  m.liters += r.liters ?? 0;
  m.co2 += r.co2 ?? 0;
  pendingMeters.set(companyId, m);
}

export function hourStart(at = new Date()) {
  return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);
}

export async function flushMeters(at = new Date()) {
  if (pendingMeters.size === 0) return;
  const hour = hourStart(at);
  const batch = [...pendingMeters.entries()];
  pendingMeters.clear();
  /* 2.4 : toutes les compagnies en une requête (avant : une par compagnie).
     L'heure est passée en texte UTC, comme Prisma l'écrit dans la colonne. */
  const hourIso = hour.toISOString();
  for (const part of chunk(batch, 500)) {
    try {
      await prisma.$executeRaw`
        INSERT INTO "EnergyMeter" ("id", "companyId", "hour", "kwh", "liters", "co2")
        SELECT v.id::text, v.company::text, ${hourIso}::timestamp(3), v.kwh::float8, v.liters::float8, v.co2::float8
        FROM (VALUES ${Prisma.join(part.map(([companyId, r]) => row([randomUUID(), companyId, r.kwh, r.liters, r.co2])))}) AS v(id, company, kwh, liters, co2)
        ON CONFLICT ("companyId", "hour") DO UPDATE SET
          "kwh" = "EnergyMeter"."kwh" + EXCLUDED."kwh",
          "liters" = "EnergyMeter"."liters" + EXCLUDED."liters",
          "co2" = "EnergyMeter"."co2" + EXCLUDED."co2"`;
    } catch (err) {
      // une compagnie supprimée entre-temps fait échouer le lot : on repasse une par une
      console.error("[énergie] compteurs groupés :", (err as Error).message);
      for (const [companyId, r] of part) {
        await prisma.energyMeter
          .upsert({
            where: { companyId_hour: { companyId, hour } },
            create: { companyId, hour, kwh: r.kwh, liters: r.liters, co2: r.co2 },
            update: { kwh: { increment: r.kwh }, liters: { increment: r.liters }, co2: { increment: r.co2 } },
          })
          .catch((e: Error) => console.error("[énergie] compteur :", e.message));
      }
    }
  }
}

/* ---------------- les cours ---------------- */

type Index = { value: number; shock: number; shockUntil: Date | null; shockLabel: string | null };
let indexCache: { at: number; diesel: Index; power: Index } | null = null;
const NEUTRAL: Index = { value: 1, shock: 1, shockUntil: null, shockLabel: null };

export async function loadIndices(force = false) {
  if (!force && indexCache && Date.now() - indexCache.at < 60_000) return indexCache;
  const rows = (await prisma.marketIndex.findMany().catch(() => [])) as (Index & { kind: string })[];
  const pick = (k: string) => {
    const r = rows.find((x) => x.kind === k);
    if (!r) return NEUTRAL;
    const live = r.shockUntil && r.shockUntil.getTime() > Date.now();
    return { value: r.value, shock: live ? r.shock : 1, shockUntil: live ? r.shockUntil : null, shockLabel: live ? r.shockLabel : null };
  };
  indexCache = { at: Date.now(), diesel: pick("DIESEL"), power: pick("POWER") };
  return indexCache;
}

/* Le profil du courant selon l'heure (heure de Paris) et la saison. */
export function powerProfile(at = new Date()) {
  const s = economy();
  const h = parisHour(at);
  const month = parisDate(at).month;
  if ((h >= 7 && h < 9) || (h >= 17 && h < 20)) return { factor: s.peakFactor, label: "heure de pointe" };
  if (h < 6) return { factor: s.nightFactor, label: "heures creuses" };
  if (month >= 4 && month <= 9 && h >= 11 && h < 15) return { factor: s.summerNoonFactor, label: "plein soleil" };
  return { factor: 1, label: "heures pleines" };
}

export function dieselPrice(idx: Index = indexCache?.diesel ?? NEUTRAL) {
  const s = economy();
  return Math.min(s.dieselMax * 1.6, Math.max(s.dieselMin * 0.7, s.dieselBase * idx.value * idx.shock));
}

export function powerPrice(at = new Date(), idx: Index = indexCache?.power ?? NEUTRAL) {
  return economy().powerBase * idx.value * idx.shock * powerProfile(at).factor;
}

export function companyDieselPrice(c: { dieselFixedPrice: number | null; dieselFixedUntil: Date | null }, now = Date.now()) {
  if (c.dieselFixedPrice && c.dieselFixedUntil && c.dieselFixedUntil.getTime() > now) return c.dieselFixedPrice;
  return dieselPrice();
}

export function companyPowerPrice(c: { powerFixedPrice: number | null; powerFixedUntil: Date | null }, at = new Date()) {
  if (c.powerFixedPrice && c.powerFixedUntil && c.powerFixedUntil.getTime() > at.getTime()) return c.powerFixedPrice;
  return powerPrice(at);
}

/* ---------------- événements du réseau électrique ---------------- */

type EnergyEvents = { outage?: { region: string; until: string } | null; lastMarketHour?: string | null };
let eventsCache: { at: number; ev: EnergyEvents } | null = null;

export async function energyEvents(force = false): Promise<EnergyEvents> {
  if (!force && eventsCache && Date.now() - eventsCache.at < 30_000) return eventsCache.ev;
  const row = await prisma.gameSetting.findUnique({ where: { key: "energyEvents" } }).catch(() => null);
  const ev = ((row?.value as EnergyEvents) ?? {}) as EnergyEvents;
  eventsCache = { at: Date.now(), ev };
  return ev;
}

async function saveEvents(ev: EnergyEvents) {
  await prisma.gameSetting.upsert({ where: { key: "energyEvents" }, create: { key: "energyEvents", value: ev as object }, update: { value: ev as object } });
  eventsCache = { at: Date.now(), ev };
}

/* La région privée de courant en ce moment, s'il y en a une. */
export function outageNow(ev: EnergyEvents | null = eventsCache?.ev ?? null, now = Date.now()) {
  const o = ev?.outage;
  return o && new Date(o.until).getTime() > now ? o : null;
}

export function routeInOutage(route: string[], now = Date.now()) {
  const o = outageNow(undefined, now);
  return Boolean(o && route.some((st) => REGION_OF[st] === o.region));
}

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type EnergyAnnouncement = { kind: "diesel-shock" | "diesel-drop" | "cold" | "outage"; title: string; body: string };

/* Une fois par heure : les cours bougent, un choc ou une panne peut survenir. */
export async function runEnergyMarkets(weather: Map<string, StationWeather>, now = new Date()): Promise<EnergyAnnouncement[]> {
  const s = economy();
  const ev = await energyEvents(true);
  const hourKey = hourStart(now).toISOString();
  if (ev.lastMarketHour === hourKey) return [];
  const out: EnergyAnnouncement[] = [];
  const rows = (await prisma.marketIndex.findMany()) as (Index & { kind: string })[];
  const get = (k: string) => rows.find((r) => r.kind === k);

  // gazole : retour lent vers le prix de référence, un peu de hasard
  const d = get("DIESEL");
  let dv = d?.value ?? 1;
  dv = Math.min(s.dieselMax / s.dieselBase, Math.max(s.dieselMin / s.dieselBase, dv + 0.15 * (1 - dv) + gauss() * 0.04));
  let dShock = d && d.shockUntil && d.shockUntil > now ? d.shock : 1;
  let dUntil = d && d.shockUntil && d.shockUntil > now ? d.shockUntil : null;
  let dLabel = d && d.shockUntil && d.shockUntil > now ? d.shockLabel : null;
  if (!dUntil && Math.random() < s.dieselShockChancePerHour) {
    dShock = 1.6;
    dUntil = new Date(now.getTime() + 72 * 3_600_000);
    dLabel = "Crise pétrolière : gazole +60 % pendant trois jours";
    out.push({ kind: "diesel-shock", title: "⛽ Crise pétrolière", body: "Le gazole prend 60 % pour trois jours. Les cuves pleines et les contrats à prix fixe n'y sont pas exposés." });
  } else if (!dUntil && Math.random() < s.dieselShockChancePerHour / 2) {
    dShock = 0.7;
    dUntil = new Date(now.getTime() + 48 * 3_600_000);
    dLabel = "Le pétrole dégringole : gazole −30 % pendant deux jours";
    out.push({ kind: "diesel-drop", title: "⛽ Le gazole baisse", body: "Gazole −30 % pendant deux jours : c'est le moment de remplir les cuves." });
  }

  // courant : même principe ; une vague de froid fait grimper le prix
  const p = get("POWER");
  let pv = p?.value ?? 1;
  pv = Math.min(1.5, Math.max(0.7, pv + 0.2 * (1 - pv) + gauss() * 0.03));
  const temps = [...weather.values()].filter((w) => REGION_OF[w.station] && REGION_OF[w.station] !== "etranger").map((w) => w.temp);
  const avgTemp = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 10;
  const cold = avgTemp < 0;
  const wasCold = Boolean(p?.shockUntil && p.shockUntil > now && p.shockLabel?.startsWith("Vague de froid"));
  const pShock = cold ? s.coldFactor : 1;
  const pUntil = cold ? new Date(now.getTime() + 2 * 3_600_000) : null;
  const pLabel = cold ? `Vague de froid : courant +${Math.round((s.coldFactor - 1) * 100)} %` : null;
  if (cold && !wasCold) out.push({ kind: "cold", title: "🥶 Vague de froid", body: `Le courant prend ${Math.round((s.coldFactor - 1) * 100)} % tant que le froid dure. Aux heures de pointe, laisser des rames au dépôt rapporte une prime.` });

  // panne de sous-station
  if (!outageNow(ev, now.getTime()) && Math.random() < s.outageChancePerHour) {
    const candidates = REGIONS.filter((r) => !r.dlc && r.id !== "etranger");
    const region = candidates[Math.floor(Math.random() * candidates.length)];
    ev.outage = { region: region.id, until: new Date(now.getTime() + s.outageMinutes * 60_000).toISOString() };
    out.push({ kind: "outage", title: `⚡ Panne de sous-station : ${region.name}`, body: `Plus de courant en ${region.name} pendant ${s.outageMinutes} minutes. Les rames électriques y sont arrêtées, le diesel roule.` });
  }

  await prisma.$transaction([
    prisma.marketIndex.upsert({
      where: { kind: "DIESEL" },
      create: { kind: "DIESEL", value: dv, shock: dShock, shockUntil: dUntil, shockLabel: dLabel },
      update: { value: dv, shock: dShock, shockUntil: dUntil, shockLabel: dLabel },
    }),
    prisma.marketIndex.upsert({
      where: { kind: "POWER" },
      create: { kind: "POWER", value: pv, shock: pShock, shockUntil: pUntil, shockLabel: pLabel },
      update: { value: pv, shock: pShock, shockUntil: pUntil, shockLabel: pLabel },
    }),
  ]);
  const fresh = await loadIndices(true);
  await prisma.marketIndexHistory.createMany({
    data: [
      { kind: "DIESEL", value: dieselPrice(fresh.diesel), at: now },
      { kind: "POWER", value: s.powerBase * fresh.power.value * fresh.power.shock, at: now },
    ],
  });
  // on ne garde que trente jours de relevés
  await prisma.marketIndexHistory.deleteMany({ where: { at: { lt: new Date(now.getTime() - 30 * 86_400_000) } } });
  ev.lastMarketHour = hourKey;
  await saveEvents(ev);
  return out;
}

/* ---------------- la production des centrales ---------------- */

export function plantOutput(kind: PlantKind, w: StationWeather | undefined) {
  const cap = economy().plants[kind]?.kwh ?? 0;
  if (kind === "BATTERIE") return 0;
  if (kind === "BARRAGE") return cap * (w?.kind === "CANICULE" ? 0.8 : 1);
  if (kind === "SOLAIRE") {
    if (!w || !w.isDay) return 0;
    const sun = w.kind === "CLAIR" || w.kind === "CANICULE" ? 1 : w.kind === "NUAGEUX" ? 0.5 : 0.15;
    return cap * sun;
  }
  // éoliennes : rien sous 3 m/s, plein régime à 12 m/s
  const wind = w?.wind ?? 4;
  return cap * Math.min(1, Math.max(0, (wind - 3) / 9));
}

/* ---------------- le règlement de l'heure ---------------- */

export type HourBill = {
  companyId: string;
  kwh: number;
  liters: number;
  produced: number;
  fromOwn: number;
  fromBattery: number;
  fromPlayers: number;
  fromGrid: number;
  offPeakCharge: number;
  soldToPlayers: number;
  soldToGrid: number;
  dieselFromTank: number;
  powerCost: number;
  dieselCost: number;
  income: number;
  co2: number;
  bonus: number;
};

type CompanyEnergy = {
  id: string;
  balance: number;
  dieselLiters: number;
  dieselFixedPrice: number | null;
  dieselFixedUntil: Date | null;
  powerFixedPrice: number | null;
  powerFixedUntil: Date | null;
  batteryKwh: number;
  batteryOffPeak: boolean;
  powerOfferPrice: number | null;
};

/* Calcul pur du règlement d'une heure, pour toutes les compagnies d'un coup :
   chaque compagnie couvre d'abord ses besoins, puis les déficits sont servis
   par le surplus le moins cher des autres joueurs, puis par le réseau. */
export function computeSettlement(
  companies: CompanyEnergy[],
  meters: Map<string, { kwh: number; liters: number; co2: number }>,
  production: Map<string, { produced: number; batteryCap: number }>,
  hour: Date,
  opts: { tensionAlert?: boolean; baselines?: Map<string, number> } = {}
): HourBill[] {
  const s = economy();
  const grid = powerPrice(hour);
  const profile = powerProfile(hour).factor;
  const bills = new Map<string, HourBill & { surplus: number; deficit: number; battery: number; cap: number }>();

  for (const c of companies) {
    const m = meters.get(c.id) ?? { kwh: 0, liters: 0, co2: 0 };
    const prod = production.get(c.id) ?? { produced: 0, batteryCap: 0 };
    let battery = Math.min(c.batteryKwh, prod.batteryCap);
    const fromOwn = Math.min(m.kwh, prod.produced);
    let deficit = m.kwh - fromOwn;
    let surplus = prod.produced - fromOwn;
    // le surplus remplit la batterie, la batterie couvre le déficit
    const charge = Math.min(surplus, prod.batteryCap - battery);
    battery += charge;
    surplus -= charge;
    const fromBattery = Math.min(deficit, battery);
    battery -= fromBattery;
    deficit -= fromBattery;
    bills.set(c.id, {
      companyId: c.id, kwh: m.kwh, liters: m.liters, produced: prod.produced,
      fromOwn, fromBattery, fromPlayers: 0, fromGrid: 0, offPeakCharge: 0, soldToPlayers: 0, soldToGrid: 0,
      dieselFromTank: 0, powerCost: 0, dieselCost: 0, income: 0, co2: m.co2, bonus: 0,
      surplus, deficit, battery, cap: prod.batteryCap,
    });
  }

  // les vendeurs : surplus disponible, au prix qu'ils ont fixé, s'il bat le réseau
  const sellers = companies
    .filter((c) => c.powerOfferPrice !== null && c.powerOfferPrice < grid && (bills.get(c.id)?.surplus ?? 0) > 0)
    .sort((a, b) => (a.powerOfferPrice ?? 0) - (b.powerOfferPrice ?? 0));

  for (const c of companies) {
    const b = bills.get(c.id)!;
    const myPrice = companyPowerPrice(c, hour);
    for (const seller of sellers) {
      if (b.deficit <= 0) break;
      if (seller.id === c.id) continue;
      const price = seller.powerOfferPrice ?? grid;
      if (price >= myPrice) continue;
      const sb = bills.get(seller.id)!;
      const qty = Math.min(b.deficit, sb.surplus);
      if (qty <= 0) continue;
      b.deficit -= qty;
      b.fromPlayers += qty;
      b.powerCost += qty * price;
      sb.surplus -= qty;
      sb.soldToPlayers += qty;
      sb.income += qty * price;
    }
    // le reste au réseau (ou au contrat à prix fixe)
    b.fromGrid = b.deficit;
    b.powerCost += b.deficit * myPrice;
    b.co2 += b.deficit * s.co2PerGridKwh;
    // aux heures creuses, la batterie se recharge au réseau (au plus la moitié de sa capacité par heure)
    if (c.batteryOffPeak && profile < 1 && b.cap > b.battery) {
      const qty = Math.min(b.cap - b.battery, b.cap * 0.5);
      b.offPeakCharge = qty;
      b.battery += qty;
      b.powerCost += qty * myPrice;
      b.co2 += qty * s.co2PerGridKwh;
    }
  }

  for (const c of companies) {
    const b = bills.get(c.id)!;
    // le surplus invendu part au réseau, à prix réduit
    b.soldToGrid = b.surplus;
    b.income += b.surplus * grid * s.gridBuyback;
    // le gazole : la cuve d'abord, la pompe ensuite
    b.dieselFromTank = Math.min(b.liters, c.dieselLiters);
    b.dieselCost = (b.liters - b.dieselFromTank) * companyDieselPrice(c, hour.getTime());
    // alerte tension : consommer moitié moins que d'habitude rapporte une prime
    const base = opts.baselines?.get(c.id) ?? 0;
    if (opts.tensionAlert && base > 0 && b.kwh < base * 0.5) b.bonus = (base - b.kwh) * grid * 0.5;
  }

  return [...bills.values()].map(({ surplus, deficit, battery, cap, ...rest }) => ({ ...rest, batteryAfter: battery }) as HourBill & { batteryAfter: number });
}

/* Règle les heures écoulées : relit les compteurs, calcule, prélève, verse. */
export async function settleEnergy(weather: Map<string, StationWeather>, now = new Date()) {
  const current = hourStart(now);
  const open = (await prisma.energyMeter.findMany({ where: { settled: false, hour: { lt: current } }, select: { hour: true }, distinct: ["hour"], orderBy: { hour: "asc" } })) as { hour: Date }[];
  // les producteurs sans compteur ouvert produisent quand même pendant l'heure écoulée
  const lastHour = new Date(current.getTime() - 3_600_000);
  const hours = open.map((o) => o.hour);
  if (!hours.some((h) => h.getTime() === lastHour.getTime())) hours.push(lastHour);
  await loadIndices(true);
  const trial = inTrial(now.getTime());
  const s = economy();
  const allPlants = (await prisma.powerPlant.findMany({ select: { id: true, companyId: true, kind: true, station: true, builtAt: true } })) as { id: string; companyId: string; kind: PlantKind; station: string; builtAt: Date }[];

  const billedLastHour = new Set<string>();
  for (const hour of hours.slice(-6)) {
    // une centrale ne compte que pour les heures où elle existait déjà
    const plants = allPlants.filter((p) => p.builtAt.getTime() < hour.getTime() + 3_600_000);
    const rows = (await prisma.energyMeter.findMany({ where: { hour } })) as { id: string; companyId: string; kwh: number; liters: number; co2: number; settled: boolean }[];
    // les compagnies déjà facturées pour l'heure écoulée gardent leur blocage éventuel
    if (hour.getTime() === lastHour.getTime()) for (const r of rows) billedLastHour.add(r.companyId);
    // une heure déjà réglée pour tout le monde n'est pas refaite
    if (rows.length && rows.every((r) => r.settled)) continue;
    const settledIds = new Set(rows.filter((r) => r.settled).map((r) => r.companyId));
    const meters = new Map(rows.filter((r) => !r.settled).map((r) => [r.companyId, { kwh: r.kwh, liters: r.liters, co2: r.co2 }]));
    // seules les centrales construites avant la fin de l'heure produisent ; l'heure passée est créditée une fois
    const production = new Map<string, { produced: number; batteryCap: number }>();
    const producing = hour.getTime() === lastHour.getTime();
    for (const p of plants) {
      if (settledIds.has(p.companyId)) continue;
      const cur = production.get(p.companyId) ?? { produced: 0, batteryCap: 0 };
      if (p.kind === "BATTERIE") cur.batteryCap += s.plants.BATTERIE.kwh;
      else if (producing) cur.produced += plantOutput(p.kind, weather.get(p.station));
      production.set(p.companyId, cur);
    }
    const ids = [...new Set([...meters.keys(), ...production.keys()])];
    if (hour.getTime() === lastHour.getTime()) for (const id of ids) billedLastHour.add(id);
    if (ids.length === 0) continue;
    const companies = (await prisma.company.findMany({
      where: { id: { in: ids } },
      select: { id: true, balance: true, dieselLiters: true, dieselFixedPrice: true, dieselFixedUntil: true, powerFixedPrice: true, powerFixedUntil: true, batteryKwh: true, batteryOffPeak: true, powerOfferPrice: true },
    })) as CompanyEnergy[];

    // alerte tension : vague de froid et heure de pointe
    const idx = indexCache?.power;
    const tensionAlert = Boolean(idx && idx.shock > 1 && powerProfile(hour).factor > 1);
    let baselines: Map<string, number> | undefined;
    if (tensionAlert) {
      const past = (await (prisma.energyMeter.groupBy as any)({
        by: ["companyId"],
        where: { companyId: { in: ids }, hour: { gte: new Date(hour.getTime() - 24 * 3_600_000), lt: hour } },
        _avg: { kwh: true },
      })) as { companyId: string; _avg: { kwh: number | null } }[];
      baselines = new Map(past.map((p) => [p.companyId, p._avg.kwh ?? 0]));
    }

    const bills = computeSettlement(companies, meters, production, hour, { tensionAlert, baselines }) as (HourBill & { batteryAfter: number })[];
    const label = `${parisHour(hour)} h`;
    // 2.4 : une compagnie par file, plusieurs files à la fois
    await pool(bills, SIM_CONCURRENCY, async (b) => {
      const c = companies.find((x) => x.id === b.companyId)!;
      const cost = Math.round(b.powerCost + b.dieselCost);
      const income = Math.round(b.income + b.bonus);
      const ops: unknown[] = [];
      let blocked = false;
      if (!trial) {
        const net = income - cost;
        const paid = net < 0 ? Math.min(-net, Math.max(0, c.balance)) : 0;
        blocked = net < 0 && paid < -net;
        const delta = net < 0 ? -paid : net;
        if (delta !== 0) ops.push(prisma.company.update({ where: { id: c.id }, data: { balance: { increment: delta } } }));
        const parts = [
          b.kwh > 0 ? `${Math.round(b.kwh)} kWh` : null,
          b.liters > 0 ? `${Math.round(b.liters)} L de gazole` : null,
          b.soldToPlayers + b.soldToGrid > 0 ? `${Math.round(b.soldToPlayers + b.soldToGrid)} kWh revendus` : null,
          b.bonus > 0 ? `prime d'effacement ${Math.round(b.bonus)} pi.` : null,
        ].filter(Boolean);
        if (cost > 0) ops.push(prisma.transaction.create({ data: { companyId: c.id, type: "ENERGIE", amount: -cost, description: `Énergie, ${label} : ${parts.join(", ")}` } }));
        if (income > 0) ops.push(prisma.transaction.create({ data: { companyId: c.id, type: "ENERGIE_VENTE", amount: income, description: `Énergie revendue, ${label} : ${parts.join(", ")}` } }));
      }
      ops.push(
        prisma.company.update({
          where: { id: c.id },
          data: {
            batteryKwh: b.batteryAfter,
            dieselLiters: trial ? c.dieselLiters : Math.max(0, c.dieselLiters - b.dieselFromTank),
            co2Week: { increment: b.co2 }, // le CO₂ des trajets thermiques et celui du courant du réseau
            fuelBlocked: blocked,
          },
        }),
        prisma.energyMeter.upsert({
          where: { companyId_hour: { companyId: c.id, hour } },
          create: { companyId: c.id, hour, produced: b.produced, co2: b.co2, cost, income, settled: true, trial },
          update: { produced: b.produced, co2: b.co2, cost, income, settled: true, trial },
        })
      );
      await prisma.$transaction(ops as never).catch((err: Error) => console.error("[énergie] règlement :", err.message));
    }, "énergie");
    // production totale des centrales, pour la page Énergie
    if (producing) {
      for (const p of plants) {
        if (p.kind === "BATTERIE") continue;
        const out = plantOutput(p.kind, weather.get(p.station));
        if (out > 0) await prisma.powerPlant.update({ where: { id: p.id }, data: { produced: { increment: out } } }).catch(() => undefined);
      }
    }
  }
  /* 2.4.1 : une compagnie bloquée (facture de gazole impayée) dont les rames
     thermiques sont à l'arrêt ne consomme plus rien, n'a donc plus de facture,
     et le blocage n'était jamais levé : ses rames restaient figées pour
     toujours. Le blocage dure désormais jusqu'à la facture suivante. */
  await prisma.company
    .updateMany({ where: { fuelBlocked: true, id: { notIn: [...billedLastHour] } }, data: { fuelBlocked: false } })
    .catch((err: Error) => console.error("[énergie] levée des blocages :", err.message));

  // trente jours de compteurs suffisent
  await prisma.energyMeter.deleteMany({ where: { hour: { lt: new Date(now.getTime() - 30 * 86_400_000) } } });
}
