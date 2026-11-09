import { prisma } from "../prisma";
import { ensureTrialStart, loadEconomy } from "./settings.service";
import { energyEvents, flushMeters, hourStart, loadIndices, outageNow, runEnergyMarkets, settleEnergy, EnergyAnnouncement } from "./energy.service";
import { flushTrack, loadTrack, runConcessionsHourly } from "./track.service";
import { flushPartUse, loadPartMarket, runPartsHourly } from "./parts-market.service";
import { runCarbonWeek } from "./carbon.service";
import { REGION_OF } from "./regions.service";
import { botEnabled, postOnce } from "./discord.service";
import { autoRepair, eruptionConfig, regionStatus, regionTimes, ERUPTION_REGIONS } from "./eruption.service";
import type { StationWeather } from "./realweather.service";

/* ============================================================
   2.4 : le vrai coût du rail, branché sur la simulation.

   - au début de chaque tour : réglages, cours, état des voies et du
     marché des pièces relus une fois (la simulation les lit ensuite en
     mémoire, des milliers de fois) ;
   - à la fin de chaque tour : compteurs d'énergie, usure des voies et
     pièces consommées écrits d'un bloc ;
   - une fois par heure : facture d'énergie, cours, chocs et pannes, stock
     national de pièces, usines, péages et concessions, taxe carbone du lundi.

   Chaque étape a son filet : une erreur ici ne fait jamais tomber le tour.
   ============================================================ */

type Notify = (companyId: string, title: string, body: string) => Promise<void>;

export async function economyBeforeTick(now = new Date()) {
  await loadEconomy().catch(() => undefined);
  await ensureTrialStart(now).catch((err) => console.error("[2.4] période d'essai :", (err as Error).message));
  await Promise.all([
    loadIndices(true).catch(() => undefined),
    energyEvents(true).catch(() => undefined),
    loadTrack(now).catch((err) => console.error("[voies] lecture :", (err as Error).message)),
    loadPartMarket().catch(() => undefined),
  ]);
}

let lastHourly = 0;

export async function economyAfterTick(weather: Map<string, StationWeather>, notify: Notify, now = new Date()) {
  await flushMeters(now).catch((err) => console.error("[énergie] compteurs :", (err as Error).message));
  await flushTrack().catch((err) => console.error("[voies] écriture :", (err as Error).message));
  await flushPartUse().catch((err) => console.error("[pièces] écriture :", (err as Error).message));

  await eruptionNews(notify, now).catch((err) => console.error("[éruption] annonces :", (err as Error).message));

  const hour = hourStart(now).getTime();
  if (hour === lastHourly) return;
  lastHourly = hour;

  await settleEnergy(weather, now).catch((err) => console.error("[énergie] règlement :", (err as Error).message));
  const news = await runEnergyMarkets(weather, now).catch((err) => {
    console.error("[énergie] cours :", (err as Error).message);
    return [] as EnergyAnnouncement[];
  });
  for (const n of news) await announceEnergy(n, notify, now).catch(() => undefined);
  // 2.7 : les sous-stations oubliées se réparent toutes seules
  const auto = await autoRepair(now.getTime()).catch(() => [] as string[]);
  for (const region of auto) {
    const name = ERUPTION_REGIONS.find((r) => r.id === region)?.name ?? region;
    if (botEnabled()) await postOnce(`eruption:auto:${region}`, "ENERGIE", [{ embeds: [{ title: `⚡ Courant rétabli : ${name}`, description: `Les équipes d'astreinte ont fini par réparer la sous-station de ${name}, sans l'aide des compagnies.`, color: 0x3fa45b }] }]).catch(() => undefined);
  }
  await runPartsHourly(now).catch((err) => console.error("[pièces] marché :", (err as Error).message));
  const lost = await runConcessionsHourly(now).catch((err) => {
    console.error("[voies] concessions :", (err as Error).message);
    return [] as { companyId: string; segmentKey: string }[];
  });
  for (const l of lost) {
    await notify(l.companyId, "Concession perdue", `La liaison ${l.segmentKey.replace("|", " – ")} est restée trop longtemps sous 50 % : elle repasse en vente.`).catch(() => undefined);
  }
  const carbon = await runCarbonWeek(now).catch((err) => {
    console.error("[carbone] semaine :", (err as Error).message);
    return null;
  });
  if (carbon && !carbon.trial && carbon.billed > 0) console.log(`[carbone] semaine du ${carbon.week} : ${carbon.billed} compagnies, ${carbon.total} pi.`);
}

/* Les chocs et pannes : dans #⛽・énergie sur Discord (#annonces si le salon
   n'existe pas encore), et une notification aux compagnies touchées par une
   panne de sous-station. Les mouvements du gazole mentionnent 🔔 Événements ;
   la vague de froid et la panne, plus fréquentes, partent sans mention. */
const ENERGY_COLOR: Record<EnergyAnnouncement["kind"], number> = { "diesel-shock": 0xa8483a, "diesel-drop": 0x3fa45b, cold: 0x4f9fd8, outage: 0xe0b100 };
async function announceEnergy(n: EnergyAnnouncement, notify: Notify, now: Date) {
  if (botEnabled()) {
    const key = `energie:${n.kind}:${hourStart(now).toISOString()}`;
    const payload = [{ embeds: [{ title: n.title, description: n.body, color: ENERGY_COLOR[n.kind], footer: { text: "Marché de l'énergie · Réseau" }, timestamp: now.toISOString() }] }];
    const ping = n.kind === "diesel-shock" || n.kind === "diesel-drop" ? ("EVENEMENTS" as const) : undefined;
    const sent = await postOnce(key, "ENERGIE", payload, { ping }).catch((err) => {
      console.error("[discord] énergie :", (err as Error).message);
      return false;
    });
    if (!sent) await postOnce(key, "ANNONCES", payload, { ping }).catch(() => undefined);
  }
  if (n.kind !== "outage") return;
  const o = outageNow(await energyEvents(true), now.getTime());
  if (!o) return;
  const lines = (await prisma.line.findMany({ where: { electrified: true }, select: { companyId: true, departureStation: true, arrivalStation: true, stops: true } })) as {
    companyId: string; departureStation: string; arrivalStation: string; stops: string[];
  }[];
  const hit = new Set(lines.filter((l) => [l.departureStation, ...(l.stops ?? []), l.arrivalStation].some((st) => REGION_OF[st] === o.region)).map((l) => l.companyId));
  for (const companyId of hit) await notify(companyId, n.title, n.body).catch(() => undefined);
}

/* 2.7 : l'éruption solaire, racontée au fil des tours : le début, puis chaque
   région qui passe en tension réduite et chaque coupure. Les clés déjà
   annoncées sont gardées en mémoire (et en base par postOnce) : rien n'est
   envoyé deux fois, et rien n'est relu tant qu'il n'y a rien à dire. */
const told = new Set<string>();
async function eruptionNews(notify: Notify, now: Date) {
  const cfg = eruptionConfig();
  if (!cfg) return;
  const t = now.getTime();
  const say = async (key: string, title: string, body: string, color: number) => {
    if (told.has(key)) return false;
    told.add(key);
    if (botEnabled()) await postOnce(key, "ENERGIE", [{ embeds: [{ title, description: body, color, timestamp: now.toISOString() }] }], { ping: key.endsWith(":debut") ? "EVENEMENTS" : undefined }).catch(() => undefined);
    return true;
  };
  const start = Date.parse(cfg.startsAt);
  if (t >= start && t - start < 6 * 3_600_000) {
    await say(`eruption:${cfg.startsAt}:debut`, "☀️ Éruption solaire", "Une éruption solaire frappe le réseau électrique. Les sous-stations tombent une à une : les rames électriques ralentissent puis s'arrêtent. Le diesel et la vapeur roulent. Livrez du matériel électrique pour réparer.", 0xe07a1f);
  }
  for (const r of ERUPTION_REGIONS) {
    const times = regionTimes(r.id);
    if (!times) continue;
    const status = regionStatus(r.id, t);
    if (status === "reduite" && t - times.alertAt < 3_600_000) {
      await say(`eruption:${cfg.startsAt}:reduite:${r.id}`, `⚠️ Courant faible : ${r.name}`, `Les rames électriques de la région roulent à moitié de leur vitesse. Coupure dans ${cfg.reducedMinutes} minutes.`, 0xe0b100);
    }
    if (status === "coupee" && t - times.cutAt < 3_600_000) {
      const fresh = await say(`eruption:${cfg.startsAt}:coupee:${r.id}`, `🔌 Coupure : ${r.name}`, `Plus de courant en ${r.name}. Les rames électriques finissent leur trajet et restent à quai jusqu'à la réparation de la sous-station.`, 0xa8483a);
      if (fresh) {
        const lines = (await prisma.line.findMany({ where: { electrified: true }, select: { companyId: true, departureStation: true, arrivalStation: true, stops: true } })) as { companyId: string; departureStation: string; arrivalStation: string; stops: string[] }[];
        const hit = new Set(lines.filter((l) => [l.departureStation, ...(l.stops ?? []), l.arrivalStation].some((st) => REGION_OF[st] === r.id)).map((l) => l.companyId));
        for (const companyId of hit) await notify(companyId, `Coupure de courant : ${r.name}`, "Vos rames électriques de la région restent à quai jusqu'à la réparation de la sous-station. Le diesel roule.").catch(() => undefined);
      }
    }
  }
}
