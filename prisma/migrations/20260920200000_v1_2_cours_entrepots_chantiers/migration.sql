-- v1.2 — Cours du fret, entrepôts et chantiers.
--
-- Trois tables de compagnie (entrepôt, stock, chantier), une table de monde
-- (le cours, partagé par tous) et deux tables réservées aux abonnés.
-- Aucune colonne existante n'est modifiée : les compagnies en place continuent
-- de fonctionner à l'identique tant qu'elles ne construisent pas d'entrepôt.

CREATE TABLE "CargoMarket" (
    "cargoType" TEXT NOT NULL,
    "basePrice" INTEGER NOT NULL,
    "index" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "history" TEXT NOT NULL DEFAULT '[]',
    "eventLabel" TEXT,
    "eventUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CargoMarket_pkey" PRIMARY KEY ("cargoType")
);

CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 20,
    "level" INTEGER NOT NULL DEFAULT 1,
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Warehouse_companyId_key" ON "Warehouse"("companyId");
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StockLot" (
    "id" TEXT NOT NULL,
    "cargoType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "avgUnitPrice" DOUBLE PRECISION NOT NULL,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "StockLot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockLot_companyId_cargoType_key" ON "StockLot"("companyId", "cargoType");
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Construction" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "cost" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "Construction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Construction_companyId_done_idx" ON "Construction"("companyId", "done");
ALTER TABLE "Construction" ADD CONSTRAINT "Construction_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PriceAlert" (
    "id" TEXT NOT NULL,
    "cargoType" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "triggeredAt" TIMESTAMP(3),
    "seen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "PriceAlert_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PriceAlert_companyId_idx" ON "PriceAlert"("companyId");
ALTER TABLE "PriceAlert" ADD CONSTRAINT "PriceAlert_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StandingOrder" (
    "id" TEXT NOT NULL,
    "cargoType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "quantity" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "StandingOrder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StandingOrder_companyId_active_idx" ON "StandingOrder"("companyId", "active");
ALTER TABLE "StandingOrder" ADD CONSTRAINT "StandingOrder_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
