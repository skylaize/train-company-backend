import { PrismaClient } from "@prisma/client";

/* 2.4 : taille du pool de connexions.

   Sans réglage, Prisma ouvre (nombre de cœurs × 2 + 1) connexions : 5 sur un
   VPS à 2 cœurs. La simulation fait maintenant avancer plusieurs compagnies
   en parallèle (SIM_CONCURRENCY, 6 par défaut) et les joueurs ont besoin de
   connexions en même temps : on monte à 15 par défaut.

   Si DATABASE_URL précise déjà connection_limit, on n'y touche pas. Sinon,
   DB_POOL_SIZE permet de changer la valeur sans toucher à l'adresse. */
function withPool(url: string | undefined) {
  if (!url || /[?&]connection_limit=/.test(url)) return url;
  const size = Number(process.env.DB_POOL_SIZE) || 15;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=${size}&pool_timeout=20`;
}

const url = withPool(process.env.DATABASE_URL);

export const prisma = url ? new PrismaClient({ datasourceUrl: url }) : new PrismaClient();
