// Script à lancer UNE SEULE FOIS pour corriger les données existantes,
// suite au bug où les contrats livrés gardaient leur trainId (empêchant
// de réaffecter le même train à un nouveau contrat de fret).
//
// Utilisation, depuis le dossier train-company-backend :
//   npx ts-node scripts/fix-delivered-contracts.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.contract.updateMany({
    where: { status: "LIVREE", trainId: { not: null } },
    data: { trainId: null },
  });

  console.log(`${result.count} contrat(s) livré(s) nettoyé(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
