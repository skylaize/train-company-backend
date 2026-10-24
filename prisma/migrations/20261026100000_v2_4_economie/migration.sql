-- 2.4 : le vrai coût du rail (gazole, électricité, carbone, pièces, voies, centrales)

ALTER TABLE "Company" ADD COLUMN "dieselTanks" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Company" ADD COLUMN "dieselLiters" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Company" ADD COLUMN "dieselFixedPrice" DOUBLE PRECISION;
ALTER TABLE "Company" ADD COLUMN "dieselFixedUntil" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "powerFixedPrice" DOUBLE PRECISION;
ALTER TABLE "Company" ADD COLUMN "powerFixedUntil" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "batteryKwh" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Company" ADD COLUMN "batteryOffPeak" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Company" ADD COLUMN "powerOfferPrice" DOUBLE PRECISION;
ALTER TABLE "Company" ADD COLUMN "co2Week" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Company" ADD COLUMN "fuelBlocked" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "GameSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GameSetting_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "EnergyMeter" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "kwh" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "liters" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "produced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "co2" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "income" INTEGER NOT NULL DEFAULT 0,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "trial" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "EnergyMeter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EnergyMeter_companyId_hour_key" ON "EnergyMeter"("companyId", "hour");
CREATE INDEX "EnergyMeter_hour_settled_idx" ON "EnergyMeter"("hour", "settled");
ALTER TABLE "EnergyMeter" ADD CONSTRAINT "EnergyMeter_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CarbonBill" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "week" TEXT NOT NULL,
    "emitted" DOUBLE PRECISION NOT NULL,
    "quota" DOUBLE PRECISION NOT NULL,
    "taxable" DOUBLE PRECISION NOT NULL,
    "valuation" INTEGER NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "amount" INTEGER NOT NULL,
    "trial" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CarbonBill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CarbonBill_companyId_week_key" ON "CarbonBill"("companyId", "week");
ALTER TABLE "CarbonBill" ADD CONSTRAINT "CarbonBill_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MarketIndex" (
    "kind" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "shock" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "shockUntil" TIMESTAMP(3),
    "shockLabel" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketIndex_pkey" PRIMARY KEY ("kind")
);

CREATE TABLE "MarketIndexHistory" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketIndexHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MarketIndexHistory_kind_at_idx" ON "MarketIndexHistory"("kind", "at");

CREATE TABLE "PowerPlant" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "produced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PowerPlant_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PowerPlant_companyId_idx" ON "PowerPlant"("companyId");
ALTER TABLE "PowerPlant" ADD CONSTRAINT "PowerPlant_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PartMarket" (
    "part" TEXT NOT NULL,
    "stock" INTEGER NOT NULL,
    "target" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartMarket_pkey" PRIMARY KEY ("part")
);

CREATE TABLE "PartFactory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "part" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "stored" INTEGER NOT NULL DEFAULT 0,
    "salePrice" INTEGER,
    "producedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartFactory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PartFactory_companyId_idx" ON "PartFactory"("companyId");
CREATE INDEX "PartFactory_part_salePrice_idx" ON "PartFactory"("part", "salePrice");
ALTER TABLE "PartFactory" ADD CONSTRAINT "PartFactory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TrackSegment" (
    "key" TEXT NOT NULL,
    "condition" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "fund" INTEGER NOT NULL DEFAULT 0,
    "round" INTEGER NOT NULL DEFAULT 0,
    "renovatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackSegment_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "TrackFunding" (
    "id" TEXT NOT NULL,
    "segmentKey" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackFunding_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TrackFunding_segmentKey_round_idx" ON "TrackFunding"("segmentKey", "round");
CREATE INDEX "TrackFunding_companyId_at_idx" ON "TrackFunding"("companyId", "at");
ALTER TABLE "TrackFunding" ADD CONSTRAINT "TrackFunding_segmentKey_fkey" FOREIGN KEY ("segmentKey") REFERENCES "TrackSegment"("key") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Concession" (
    "id" TEXT NOT NULL,
    "segmentKey" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "toll" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "invested" INTEGER NOT NULL,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "totalTolls" INTEGER NOT NULL DEFAULT 0,
    "lowSince" TIMESTAMP(3),
    "protectedUntil" TIMESTAMP(3) NOT NULL,
    "boughtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Concession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Concession_segmentKey_key" ON "Concession"("segmentKey");
CREATE INDEX "Concession_companyId_idx" ON "Concession"("companyId");
ALTER TABLE "Concession" ADD CONSTRAINT "Concession_segmentKey_fkey" FOREIGN KEY ("segmentKey") REFERENCES "TrackSegment"("key") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Concession" ADD CONSTRAINT "Concession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
