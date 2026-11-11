import { prisma } from "../prisma";
import { sendToCompany } from "./push.service";
import { parisDay } from "./report.service";

/* ============================================================
   2.6 : gares surveillées, et solde du soir.

   Surveiller une gare : tous ceux qui la surveillent reçoivent la même
   notification au même tour, 10 minutes avant la fin de sa protection, puis
   quand elle tombe. Personne ne part avec une longueur d'avance.

   Solde du soir : à minuit (Paris), le solde de chaque compagnie est noté
   pour la journée qui se termine. La page Rentabilité en tire la vraie
   courbe de la trésorerie, salaires compris.
   ============================================================ */

const SOON_MS = 10 * 60_000;
const SOON_MS_PREMIUM = 30 * 60_000; // 2.7 : le Premium est prévenu 30 min avant (pas d'enchère plus forte, juste plus de temps)
const STALE_MS = 3600_000; // une fin de protection de plus d'une heure n'est plus annoncée

export async function runStationWatches(now = Date.now()) {
  const watches = (await prisma.stationWatch.findMany({ select: { companyId: true, station: true, soonFor: true, freeFor: true } })) as {
    companyId: string; station: string; soonFor: Date | null; freeFor: Date | null;
  }[];
  if (!watches.length) return;
  const premium = new Set(
    ((await prisma.company.findMany({ where: { id: { in: [...new Set(watches.map((w) => w.companyId))] }, isPremium: true }, select: { id: true } })) as { id: string }[]).map((c) => c.id)
  );
  const owners = (await prisma.stationOwnership.findMany({
    where: { station: { in: [...new Set(watches.map((w) => w.station))] }, protectedUntil: { gte: new Date(now - STALE_MS), lte: new Date(now + SOON_MS_PREMIUM) } },
    select: { station: true, companyId: true, protectedUntil: true, company: { select: { name: true } } },
  })) as { station: string; companyId: string; protectedUntil: Date; company: { name: string } }[];
  if (!owners.length) return;
  const byStation = new Map(owners.map((o) => [o.station, o]));

  for (const w of watches) {
    const o = byStation.get(w.station);
    if (!o || o.companyId === w.companyId) continue;
    const end = new Date(o.protectedUntil);
    const free = end.getTime() <= now;
    if (!free && end.getTime() - now > (premium.has(w.companyId) ? SOON_MS_PREMIUM : SOON_MS)) continue;
    const sent = free ? w.freeFor : w.soonFor;
    if (sent && new Date(sent).getTime() === end.getTime()) continue;
    // marqué d'abord : un envoi qui échoue n'est pas renvoyé à chaque tour
    await prisma.stationWatch.update({
      where: { companyId_station: { companyId: w.companyId, station: w.station } },
      data: free ? { freeFor: end, soonFor: end } : { soonFor: end },
    });
    void sendToCompany(w.companyId, {
      title: free ? `Gare de ${w.station} : enchères ouvertes` : `Gare de ${w.station} : enchères dans ${Math.max(1, Math.round((end.getTime() - now) / 60_000))} min`,
      body: free
        ? `La protection de ${o.company.name} est tombée : 10 minutes d'enchères, la meilleure offre l'emporte.`
        : `La protection de ${o.company.name} tombe bientôt, puis 10 minutes d'enchères. La meilleure offre l'emporte.`,
      url: "/dashboard",
      tag: `gare-${w.station}`,
    }).catch(() => undefined);
  }
}

let lastBalanceDay = "";
export async function runDailyBalance(now = new Date()) {
  const today = parisDay(now);
  if (lastBalanceDay === today) return;
  // la journée qui vient de se terminer ; noter le solde de « aujourd'hui » au premier tour après minuit
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }).format(now));
  if (hour !== 0) {
    lastBalanceDay = lastBalanceDay || today; // au démarrage hors de minuit, on attend la nuit suivante
    return;
  }
  const yesterday = parisDay(new Date(now.getTime() - 3 * 3600_000));
  // une seule requête pour toutes les compagnies ; rejouée sans effet grâce à la clé (compagnie, jour)
  await prisma.$executeRaw`
    INSERT INTO "DailyBalance" ("companyId", "day", "balance")
    SELECT "id", ${yesterday}, "balance" FROM "Company"
    ON CONFLICT ("companyId", "day") DO NOTHING`;
  await prisma.$executeRaw`DELETE FROM "DailyBalance" WHERE "day" < ${parisDay(new Date(now.getTime() - 40 * 86_400_000))}`;
  lastBalanceDay = today;
}
