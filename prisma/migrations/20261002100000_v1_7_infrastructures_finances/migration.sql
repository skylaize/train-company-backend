-- 1.7 : gares, ateliers, emprunts, bourse
ALTER TABLE "Company" ADD COLUMN "sharePrice" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Company" ADD COLUMN "lastWeeklyReport" TEXT;
ALTER TABLE "Company" ADD COLUMN "lastDividendOn" TEXT;
ALTER TABLE "Line" ADD COLUMN "autoPrice" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "StationOwnership" (
    "station" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "invested" INTEGER NOT NULL,
    "protectedUntil" TIMESTAMP(3) NOT NULL,
    "pendingFees" INTEGER NOT NULL DEFAULT 0,
    "pendingShops" INTEGER NOT NULL DEFAULT 0,
    "totalFees" INTEGER NOT NULL DEFAULT 0,
    "totalShops" INTEGER NOT NULL DEFAULT 0,
    "boughtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "protectionNotified" BOOLEAN NOT NULL DEFAULT false,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "StationOwnership_pkey" PRIMARY KEY ("station")
);

CREATE TABLE "Workshop" (
    "id" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "Workshop_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Workshop_companyId_station_key" ON "Workshop"("companyId", "station");

CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "principal" INTEGER NOT NULL,
    "ratePct" DOUBLE PRECISION NOT NULL,
    "totalDue" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "hours" INTEGER NOT NULL,
    "missed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPaidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "warnedAt" TIMESTAMP(3),
    "companyId" TEXT NOT NULL,
    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Loan_companyId_closedAt_idx" ON "Loan"("companyId", "closedAt");

CREATE TABLE "Shareholding" (
    "id" TEXT NOT NULL,
    "shares" INTEGER NOT NULL,
    "invested" INTEGER NOT NULL,
    "holderId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    CONSTRAINT "Shareholding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Shareholding_holderId_issuerId_key" ON "Shareholding"("holderId", "issuerId");
CREATE INDEX "Shareholding_issuerId_idx" ON "Shareholding"("issuerId");

CREATE TABLE "SharePrice" (
    "id" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "SharePrice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SharePrice_companyId_at_idx" ON "SharePrice"("companyId", "at");

CREATE TABLE "StockOrder" (
    "id" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "shares" INTEGER NOT NULL,
    "limitPrice" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "StockOrder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StockOrder_companyId_idx" ON "StockOrder"("companyId");

CREATE TABLE "LineLoadHour" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "trips" INTEGER NOT NULL DEFAULT 0,
    "passengers" INTEGER NOT NULL DEFAULT 0,
    "seats" INTEGER NOT NULL DEFAULT 0,
    "left" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "LineLoadHour_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LineLoadHour_lineId_hour_key" ON "LineLoadHour"("lineId", "hour");
CREATE INDEX "LineLoadHour_companyId_hour_idx" ON "LineLoadHour"("companyId", "hour");

ALTER TABLE "StockOrder" ADD CONSTRAINT "StockOrder_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StationOwnership" ADD CONSTRAINT "StationOwnership_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Workshop" ADD CONSTRAINT "Workshop_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Shareholding" ADD CONSTRAINT "Shareholding_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Shareholding" ADD CONSTRAINT "Shareholding_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SharePrice" ADD CONSTRAINT "SharePrice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
