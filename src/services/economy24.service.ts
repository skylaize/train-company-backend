import { prisma } from "../prisma";
import { ensureTrialStart, loadEconomy } from "./settings.service";
import { energyEvents, flushMeters, hourStart, loadIndices, outageNow, runEnergyMarkets, settleEnergy, EnergyAnnouncement } from "./energy.service";
import { flushTrack, loadTrack, runConcessionsHourly } from "./track.service";
import { flushPartUse, loadPartMarket, runPartsHourly } from "./parts-market.service";
import { runCarbonWeek } from "./carbon.service";
import { REGION_OF } from "./regions.service";
import { botEnabled, postOnce } from "./discord.service";
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

  const hour = hourStart(now).getTime();
  if (hour === lastHourly) return;
  lastHourly = hour;

  await settleEnergy(weather, now).catch((err) => console.error("[énergie] règlement :", (err as Error).message));
  const news = await runEnergyMarkets(weather, now).catch((err) => {
    console.error("[énergie] cours :", (err as Error).message);
    return [] as EnergyAnnouncement[];
  });
  for (const n of news) await announceEnergy(n, notify, now).catch(() => undefined);
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

/* Les chocs et pannes : dans #annonces sur Discord, et une notification aux
   compagnies touchées par une panne de sous-station. */
async function announceEnergy(n: EnergyAnnouncement, notify: Notify, now: Date) {
  if (botEnabled()) {
    await postOnce(`energie:${n.kind}:${hourStart(now).toISOString()}`, "ANNONCES", [{ embeds: [{ title: n.title, description: n.body, color: n.kind === "outage" ? 0xe0b100 : n.kind === "cold" ? 0x4f9fd8 : 0xa8483a }] }]);
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
