import { prisma } from "../prisma";
import { computeReputation } from "./reputation.service";
import { distanceKm, durationBetween } from "./geography.service";
import { DAY_MS, parisDate, parisMidnight, startOfParisWeek } from "./time.service";
import { pairKey } from "./station.service";

/* ============================================================
   Appels d'offres (1.5).

   Chaque semaine, trois régions cherchent une compagnie pour exploiter une
   liaison. Le calendrier suit l'heure de Paris :

     dimanche 0 h   annonce — visible des abonnés Premium seulement
     lundi 0 h      ouverture des offres pour tous
     mercredi 0 h   clôture : la meilleure offre remporte le marché
     mercredi → lundi suivant   le contrat court

   Une offre, c'est la subvention demandée par jour, entre 10 % et 100 % du
   budget de la région. Les offres sont sous pli fermé : personne ne voit le
   montant des autres. La moins chère gagne, pondérée par la réputation — une
   compagnie ponctuelle peut demander un peu plus et l'emporter quand même.

   Le titulaire touche sa subvention heure par heure, mais seulement quand une
   de ses rames roule sur la liaison : une subvention sans trains, ça n'existe
   pas. À la fin, s'il a effectué le nombre de trajets demandé, il reçoit une
   prime d'une journée ; sinon une pénalité d'une demi-journée.

   Pour soumissionner, il faut exploiter une ligne sur la liaison.
   ============================================================ */

export const TENDERS_PER_WEEK = 3;
export const MIN_BID_RATIO = 0.1;
const TICKS_PER_HOUR = 120;
const PROVEN_TRIPS = 50; // trajets à partir desquels la réputation compte pleinement // un tour de simulation toutes les 30 s

type Liaison = { region: string; a: string; b: string };

const CATALOGUE: Liaison[] = [
  { region: "Bretagne", a: "Rennes", b: "Brest" },
  { region: "Occitanie", a: "Toulouse", b: "Montpellier" },
  { region: "Occitanie", a: "Montpellier", b: "Perpignan" },
  { region: "Nouvelle-Aquitaine", a: "Bordeaux", b: "Bayonne" },
  { region: "Nouvelle-Aquitaine", a: "Poitiers", b: "La Rochelle" },
  { region: "Nouvelle-Aquitaine", a: "Limoges", b: "Poitiers" },
  { region: "Nouvelle-Aquitaine", a: "Bordeaux", b: "Pau" },
  { region: "Grand Est", a: "Strasbourg", b: "Mulhouse" },
  { region: "Grand Est", a: "Metz", b: "Nancy" },
  { region: "Grand Est", a: "Reims", b: "Metz" },
  { region: "Grand Est", a: "Reims", b: "Troyes" },
  { region: "Hauts-de-France", a: "Lille", b: "Amiens" },
  { region: "Normandie", a: "Rouen", b: "Le Havre" },
  { region: "Normandie", a: "Caen", b: "Rouen" },
  { region: "Auvergne-Rhône-Alpes", a: "Lyon", b: "Grenoble" },
  { region: "Auvergne-Rhône-Alpes", a: "Lyon", b: "Saint-Étienne" },
  { region: "Auvergne-Rhône-Alpes", a: "Clermont-Ferrand", b: "Lyon" },
  { region: "Provence-Alpes-Côte d'Azur", a: "Marseille", b: "Nice" },
  { region: "Provence-Alpes-Côte d'Azur", a: "Avignon", b: "Marseille" },
  { region: "Bourgogne-Franche-Comté", a: "Dijon", b: "Besançon" },
  { region: "Centre-Val de Loire", a: "Tours", b: "Orléans" },
  { region: "Centre-Val de Loire", a: "Orléans", b: "Chartres" },
  { region: "Pays de la Loire", a: "Nantes", b: "Angers" },
  { region: "Pays de la Loire", a: "Angers", b: "Le Mans" },
  { region: "Île-de-France", a: "Paris", b: "Chartres" },
];

// tirage reproductible : deux passages la même semaine tirent les mêmes liaisons
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Un jour du calendrier parisien, compté depuis le lundi de la semaine. */
function weekDay(weekStart: Date, offsetDays: number) {
  const d = parisDate(new Date(weekStart.getTime() + 12 * 3600_000)); // midi, loin de tout changement d'heure
  return parisMidnight(d.year, d.month, d.day + offsetDays);
}

export function budgetFor(a: string, b: string) {
  const km = distanceKm(a, b) ?? 150;
  return Math.round((1800 + km * 9) / 50) * 50;
}

export function tripsFor(a: string, b: string, contractMs: number) {
  const minutes = durationBetween(a, b) ?? 6;
  const days = contractMs / DAY_MS;
  // de quoi occuper une rame un bon tiers du temps : faisable, mais pas sans y penser
  return Math.max(20, Math.round(days * (1440 / minutes) * 0.35 / 10) * 10);
}

async function createBatch(weekStart: Date, times?: { opensAt: Date; closesAt: Date }) {
  const recent = (await prisma.tender.findMany({
    where: { weekStart: { gte: new Date(weekStart.getTime() - 15 * DAY_MS), lt: weekStart } },
    select: { stationA: true, stationB: true },
  })) as { stationA: string; stationB: string }[];
  const used = new Set(recent.map((t) => pairKey(t.stationA, t.stationB)));

  const r = rng(Math.floor(weekStart.getTime() / 1000));
  const pool = CATALOGUE.filter((l) => !used.has(pairKey(l.a, l.b)));
  const picked: Liaison[] = [];
  const regions = new Set<string>();
  while (picked.length < TENDERS_PER_WEEK && pool.length > 0) {
    const i = Math.floor(r() * pool.length);
    const [l] = pool.splice(i, 1);
    if (regions.has(l.region)) continue;
    regions.add(l.region);
    picked.push(l);
  }

  const publishedAt = weekDay(weekStart, -1);
  const opensAt = times?.opensAt ?? weekStart;
  const closesAt = times?.closesAt ?? weekDay(weekStart, 2);
  const endsAt = weekDay(weekStart, 7);
  const now = new Date();

  await prisma.tender.createMany({
    skipDuplicates: true, // l'index unique (semaine, liaison) empêche un double tirage
    data: picked.map((l) => ({
      weekStart,
      region: l.region,
      stationA: l.a,
      stationB: l.b,
      budgetPerDay: budgetFor(l.a, l.b),
      tripsRequired: tripsFor(l.a, l.b, endsAt.getTime() - closesAt.getTime()),
      publishedAt,
      opensAt,
      closesAt,
      endsAt,
      status: opensAt <= now ? "OUVERT" : "ANNONCE",
    })),
  });
}

/* Les marchés de la semaine en cours et de la suivante existent toujours à temps. */
async function ensureTenders(now: Date) {
  const week = startOfParisWeek(now);
  const next = weekDay(week, 7);
  const [thisWeek, nextWeek, total] = await Promise.all([
    prisma.tender.count({ where: { weekStart: week } }),
    prisma.tender.count({ where: { weekStart: next } }),
    prisma.tender.count(),
  ]);

  const closes = weekDay(week, 2);
  if (thisWeek === 0) {
    if (now < closes) await createBatch(week);
    /* Tout premier lancement en fin de semaine : plutôt que d'attendre lundi,
       on ouvre tout de suite un marché de 24 h, si le contrat garde au moins
       deux jours pour se jouer. */
    else if (total === 0 && weekDay(week, 7).getTime() - now.getTime() >= 3 * DAY_MS) {
      await createBatch(week, { opensAt: now, closesAt: new Date(now.getTime() + DAY_MS) });
    }
  }
  if (nextWeek === 0 && now >= weekDay(next, -1)) await createBatch(next);
}

async function linesOnPair(companyId: string, a: string, b: string) {
  return (await prisma.line.findMany({
    where: {
      companyId,
      OR: [
        { departureStation: a, arrivalStation: b },
        { departureStation: b, arrivalStation: a },
      ],
    },
    select: { id: true },
  })) as { id: string }[];
}

/* Trajets effectués sur la liaison, lus dans le libellé de chaque recette
   (« … sur A → B »), qui fige la liaison au moment du trajet. Compter par
   ligne ne suffisait pas : une ligne réorientée sur la liaison à la dernière
   minute aurait apporté avec elle tous ses trajets passés ailleurs. */
export function pairTripFilter(a: string, b: string) {
  const ends = [`sur ${a} → ${b}`, `sur ${b} → ${a}`];
  return ends.flatMap((e) => [{ description: { endsWith: e } }, { description: { endsWith: `${e} · affluence` } }]);
}

export async function tripsOnPair(companyId: string, a: string, b: string, from: Date, to: Date) {
  return prisma.transaction.count({
    where: { companyId, type: "REVENU_LIGNE", createdAt: { gte: from, lt: to }, OR: pairTripFilter(a, b) },
  });
}

/* Des trains du titulaire roulent-ils en ce moment sur la liaison ? */
export async function trainsRunningOnPair(companyId: string, a: string, b: string) {
  const ids = (await linesOnPair(companyId, a, b)).map((l) => l.id);
  if (ids.length === 0) return { ids, running: 0 };
  const running = await prisma.train.count({ where: { companyId, status: "EN_ROUTE", lineId: { in: ids } } });
  return { ids, running };
}

type Notify = (companyId: string, title: string, body: string) => Promise<void>;

async function award(t: any, notify: Notify) {
  const bids = (await prisma.tenderBid.findMany({
    where: { tenderId: t.id },
    include: { company: { select: { id: true, name: true, isPremium: true } } },
    orderBy: { createdAt: "asc" },
  })) as any[];

  if (bids.length === 0) {
    await prisma.tender.updateMany({ where: { id: t.id, status: "OUVERT" }, data: { status: "INFRUCTUEUX" } });
    return;
  }

  // la moins-disante l'emporte, pondérée par la réputation ; à égalité, la première déposée
  const scored = await Promise.all(
    bids.map(async (b) => {
      /* une compagnie sans historique a une réputation de 100 par défaut :
         on la ramène à un niveau neutre tant qu'elle n'a pas fait ses preuves */
      const [rep0, trips] = await Promise.all([
        computeReputation(b.companyId),
        prisma.transaction.count({ where: { companyId: b.companyId, type: "REVENU_LIGNE" } }),
      ]);
      const rep = trips < PROVEN_TRIPS ? Math.min(rep0, 50) : rep0;
      return { bid: b, rep, score: b.amount / (0.5 + rep / 200) };
    })
  );
  scored.sort((x, y) => x.score - y.score || x.bid.createdAt.getTime() - y.bid.createdAt.getTime());
  const winner = scored[0].bid;

  const done = await prisma.tender.updateMany({
    where: { id: t.id, status: "OUVERT" },
    data: { status: "ATTRIBUE", winnerId: winner.companyId, winningBid: winner.amount },
  });
  if (done.count === 0) return; // déjà attribué par un tour concurrent

  const liaison = `${t.stationA} – ${t.stationB}`;
  for (const { bid } of scored) {
    if (!bid.company.isPremium) continue;
    if (bid.companyId === winner.companyId) {
      await notify(bid.companyId, "Marché remporté", `${liaison} : ${bid.amount} pi. par jour jusqu'à lundi. Faites-y rouler vos rames.`);
    } else {
      await notify(bid.companyId, "Marché perdu", `${liaison} est attribué à ${winner.company.name}.`);
    }
  }
}

async function runContract(t: any) {
  const { ids, running } = await trainsRunningOnPair(t.winnerId, t.stationA, t.stationB);
  const activeTicks = t.activeTicks + (running > 0 ? 1 : 0);

  // une heure de service effectif = un vingt-quatrième de la subvention journalière
  if (activeTicks - t.paidTicks >= TICKS_PER_HOUR) {
    const amount = Math.round(t.winningBid / 24);
    /* mise à jour conditionnelle : si deux tours se chevauchaient, le second
       ne retrouverait plus le marché dans l'état lu et ne paierait pas deux fois */
    const claimed = await prisma.tender.updateMany({
      where: { id: t.id, status: "ATTRIBUE", paidTicks: t.paidTicks, activeTicks: t.activeTicks },
      data: { activeTicks, paidTicks: t.paidTicks + TICKS_PER_HOUR, paidTotal: t.paidTotal + amount },
    });
    if (claimed.count === 0) return;
    await prisma.$transaction([
      prisma.company.update({ where: { id: t.winnerId }, data: { balance: { increment: amount } } }),
      prisma.transaction.create({
        data: {
          companyId: t.winnerId,
          type: "SUBVENTION",
          amount,
          lineId: ids[0] ?? null,
          description: `Subvention · appel d'offres ${t.stationA} – ${t.stationB} (une heure de service)`,
        },
      }),
    ]);
  } else if (running > 0) {
    await prisma.tender.updateMany({ where: { id: t.id, status: "ATTRIBUE", activeTicks: t.activeTicks }, data: { activeTicks } });
  }
}

async function finish(t: any, notify: Notify) {
  const company = await prisma.company.findUnique({ where: { id: t.winnerId }, select: { isPremium: true, balance: true } });
  if (!company) {
    // titulaire disparu (compte supprimé) : le marché se referme sans lui
    await prisma.tender.updateMany({ where: { id: t.id, status: "ATTRIBUE" }, data: { status: "TERMINE", objectiveMet: false } });
    return;
  }
  const ids = (await linesOnPair(t.winnerId, t.stationA, t.stationB)).map((l) => l.id);
  const trips = await tripsOnPair(t.winnerId, t.stationA, t.stationB, t.closesAt, t.endsAt);
  const met = trips >= t.tripsRequired;
  // le reliquat d'heure entamée
  const rest = Math.round((t.winningBid / 24) * Math.max(0, t.activeTicks - t.paidTicks) / TICKS_PER_HOUR);
  /* pénalité d'une demi-journée, même si le titulaire n'a jamais fait rouler
     un train (sinon remporter un marché pour le bloquer ne coûterait rien) —
     mais jamais de quoi mettre la trésorerie dans le rouge */
  const penalty = Math.min(Math.round(t.winningBid / 2), Math.max(0, company.balance + rest));
  const settle = met ? t.winningBid : -penalty;
  const total = rest + settle;

  // clôture conditionnelle : un marché ne se solde qu'une fois
  const closed = await prisma.tender.updateMany({
    where: { id: t.id, status: "ATTRIBUE" },
    data: { status: "TERMINE", trips, objectiveMet: met, paidTicks: t.activeTicks, paidTotal: t.paidTotal + total },
  });
  if (closed.count === 0) return;

  const ops: any[] = [prisma.company.update({ where: { id: t.winnerId }, data: { balance: { increment: total } } })];
  if (rest > 0) {
    ops.push(prisma.transaction.create({
      data: { companyId: t.winnerId, type: "SUBVENTION", amount: rest, lineId: ids[0] ?? null, description: `Subvention · appel d'offres ${t.stationA} – ${t.stationB} (solde)` },
    }));
  }
  if (settle !== 0) ops.push(prisma.transaction.create({
    data: {
      companyId: t.winnerId,
      type: "SUBVENTION",
      amount: settle,
      lineId: ids[0] ?? null,
      description: met
        ? `Prime de bonne exécution · ${t.stationA} – ${t.stationB} (${trips} trajets sur ${t.tripsRequired})`
        : `Pénalité · ${t.stationA} – ${t.stationB} : ${trips} trajets sur ${t.tripsRequired} demandés`,
    },
  }));
  await prisma.$transaction(ops);

  if (company.isPremium) {
    await notify(
      t.winnerId,
      met ? "Contrat rempli" : "Contrat non rempli",
      met
        ? `${t.stationA} – ${t.stationB} : ${trips} trajets. Prime de ${t.winningBid} pi. versée.`
        : `${t.stationA} – ${t.stationB} : ${trips} trajets sur ${t.tripsRequired}.${penalty > 0 ? ` Pénalité de ${penalty} pi.` : ""}`
    );
  }
}

/* Appelée à chaque tour de simulation. */
export async function runTenders(notify: Notify) {
  const now = new Date();
  await ensureTenders(now);

  await prisma.tender.updateMany({ where: { status: "ANNONCE", opensAt: { lte: now } }, data: { status: "OUVERT" } });

  // chaque marché isolément : un marché en erreur ne bloque pas les autres
  const toAward = await prisma.tender.findMany({ where: { status: "OUVERT", closesAt: { lte: now } } });
  for (const t of toAward) {
    await award(t, notify).catch((err) => console.error(`[appels d'offres] attribution ${t.id} :`, (err as Error).message));
  }

  const running = await prisma.tender.findMany({ where: { status: "ATTRIBUE" } });
  for (const t of running) {
    const step = t.endsAt <= now ? finish(t, notify) : runContract(t);
    await step.catch((err) => console.error(`[appels d'offres] contrat ${t.id} :`, (err as Error).message));
  }
}
