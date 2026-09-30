// Geste commercial après la panne de base de données du 28 septembre 2026 :
// des pièces pour chaque compagnie qui a ouvert le jeu ce jour-là.
//
// À lancer UNE FOIS, depuis le dossier train-company-backend :
//   npx tsx scripts/compensation-28-septembre.ts                  → aperçu, rien n'est versé
//   npx tsx scripts/compensation-28-septembre.ts --montant=500 --verser
//
// Relancer le script ne verse rien deux fois : une compagnie qui a déjà reçu
// ce geste (transaction COMPENSATION portant le libellé ci-dessous) est ignorée.
//
// « Connecté le 28 » : il n'y a pas de journal des connexions, on croise donc
// tout ce qu'un joueur laisse en ouvrant le jeu ce jour-là :
//   - le défi du jour, créé au premier chargement du tableau de bord (clé 2026-09-28) ;
//   - la dernière activité enregistrée, et les bornes d'une absence ;
//   - ses propres gestes : achat de rame, ligne tracée, contrat accepté,
//     offre d'appel d'offres, embauche, succès débloqué (calculés à l'ouverture).
// Le jour est celui de Paris : du 28 à 0 h au 29 à 0 h, heure de Paris.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const LABEL = "Geste commercial : panne du 28 septembre";
const FROM = new Date("2026-09-27T22:00:00Z"); // 28/09 0 h, heure de Paris
const TO = new Date("2026-09-28T22:00:00Z"); // 29/09 0 h, heure de Paris

function arg(name: string) {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  if (!a) return null;
  const [, v] = a.split("=");
  return v ?? "";
}

async function main() {
  const amount = Number(arg("montant") ?? 500);
  const pay = arg("verser") !== null;
  if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000) {
    throw new Error("--montant doit être un nombre entier de pièces, par exemple --montant=500");
  }
  const inDay = { gte: FROM, lt: TO };

  const reasons = new Map<string, Set<string>>();
  const add = (ids: { companyId: string }[] | string[], why: string) => {
    for (const x of ids) {
      const id = typeof x === "string" ? x : x.companyId;
      if (!reasons.has(id)) reasons.set(id, new Set());
      reasons.get(id)!.add(why);
    }
  };

  const [challenges, active, trains, lines, contracts, bids, staff, unlocks, playerTx] = await Promise.all([
    prisma.dailyChallenge.findMany({ where: { date: "2026-09-28" }, select: { companyId: true } }),
    prisma.company.findMany({
      where: { OR: [{ lastActiveAt: inDay }, { absenceFrom: inDay }, { absenceTo: inDay }, { createdAt: inDay }] },
      select: { id: true },
    }),
    prisma.train.findMany({ where: { purchasedAt: inDay }, select: { companyId: true } }),
    prisma.line.findMany({ where: { createdAt: inDay }, select: { companyId: true } }),
    prisma.contract.findMany({ where: { acceptedAt: inDay, companyId: { not: null } }, select: { companyId: true } }),
    prisma.tenderBid.findMany({ where: { OR: [{ createdAt: inDay }, { updatedAt: inDay }] }, select: { companyId: true } }),
    prisma.staff.findMany({ where: { hiredAt: inDay }, select: { companyId: true } }),
    prisma.achievementUnlock.findMany({ where: { unlockedAt: inDay }, select: { companyId: true } }),
    // dépenses décidées par le joueur (pas les recettes ni les salaires, versés par la simulation)
    prisma.transaction.findMany({
      where: { createdAt: inDay, type: { in: ["ACHAT_TRAIN", "CHANTIER", "BOUTIQUE", "LICENCE", "PUBLICITE", "PARRAINAGE"] } },
      select: { companyId: true },
    }),
  ]);

  add(challenges, "a ouvert le tableau de bord");
  add(active.map((c: { id: string }) => c.id), "activité enregistrée");
  add(trains, "rame achetée");
  add(lines, "ligne tracée");
  add(contracts as { companyId: string }[], "contrat accepté");
  add(bids, "offre d'appel d'offres");
  add(staff, "embauche");
  add(unlocks, "succès débloqué");
  add(playerTx, "achat ou dépense");

  const already = new Set(
    (await prisma.transaction.findMany({ where: { type: "COMPENSATION", description: LABEL }, select: { companyId: true } })).map(
      (t: { companyId: string }) => t.companyId
    )
  );

  const companies = await prisma.company.findMany({
    where: { id: { in: [...reasons.keys()] } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  let todo = 0;
  for (const c of companies as { id: string; name: string }[]) {
    const done = already.has(c.id);
    if (!done) todo++;
    console.log(`${done ? "déjà versé " : "à verser   "} ${c.name.padEnd(32)} ${[...reasons.get(c.id)!].join(", ")}`);
  }
  console.log(`\n${companies.length} compagnie(s) connectée(s) le 28 septembre, ${todo} à indemniser, ${amount} pi. chacune (${todo * amount} pi. au total).`);

  if (!pay) {
    console.log("\nAperçu seulement. Pour verser : ajoutez --verser (et --montant=… pour changer le montant).");
    return;
  }

  let paid = 0;
  for (const c of companies as { id: string; name: string }[]) {
    if (already.has(c.id)) continue;
    await prisma.$transaction([
      prisma.company.update({ where: { id: c.id }, data: { balance: { increment: amount } } }),
      prisma.transaction.create({ data: { companyId: c.id, type: "COMPENSATION", amount, description: LABEL } }),
    ]);
    paid++;
  }
  console.log(`\n${paid} compagnie(s) indemnisée(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
