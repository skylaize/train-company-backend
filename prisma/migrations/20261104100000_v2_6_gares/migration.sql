-- 2.6 : refonte des gares (commerces, rachat qui ne s'accumule plus), gares surveillées, solde du soir

-- les gares achetées avant la 2.6 gardent la mise de leur propriétaire en cas de rachat
ALTER TABLE "StationOwnership" ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT false;
UPDATE "StationOwnership" SET "legacy" = true;

CREATE TABLE "StationShop" (
    "id" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "boughtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pendingIncome" INTEGER NOT NULL DEFAULT 0,
    "totalIncome" INTEGER NOT NULL DEFAULT 0,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "StationShop_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StationShop_station_companyId_key" ON "StationShop"("station", "companyId");
CREATE INDEX "StationShop_station_idx" ON "StationShop"("station");
ALTER TABLE "StationShop" ADD CONSTRAINT "StationShop_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StationWatch" (
    "station" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "soonFor" TIMESTAMP(3),
    "freeFor" TIMESTAMP(3),
    "companyId" TEXT NOT NULL,
    CONSTRAINT "StationWatch_pkey" PRIMARY KEY ("companyId", "station")
);
CREATE INDEX "StationWatch_station_idx" ON "StationWatch"("station");
ALTER TABLE "StationWatch" ADD CONSTRAINT "StationWatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DailyBalance" (
    "day" TEXT NOT NULL,
    "balance" INTEGER NOT NULL,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "DailyBalance_pkey" PRIMARY KEY ("companyId", "day")
);
ALTER TABLE "DailyBalance" ADD CONSTRAINT "DailyBalance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
