-- 2.3 : rame publicitaire
ALTER TABLE "Train" ADD COLUMN "adBrand" TEXT;
ALTER TABLE "Train" ADD COLUMN "adColor" TEXT;
ALTER TABLE "Train" ADD COLUMN "adUntil" TIMESTAMP(3);

-- 2.3 : conteneur scellé
ALTER TABLE "Contract" ADD COLUMN "sealed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contract" ADD COLUMN "sealedOutcome" TEXT;

-- 2.3 : objectifs d'alliance de la semaine
CREATE TABLE "AllianceWeek" (
    "id" TEXT NOT NULL,
    "allianceId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "objectives" JSONB NOT NULL,
    "baseline" JSONB NOT NULL DEFAULT '{}',
    "progress" JSONB NOT NULL DEFAULT '{}',
    "shares" JSONB NOT NULL DEFAULT '{}',
    "done" JSONB NOT NULL DEFAULT '{}',
    "bonusPaid" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AllianceWeek_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AllianceWeek_allianceId_weekStart_key" ON "AllianceWeek"("allianceId", "weekStart");
CREATE INDEX "AllianceWeek_weekStart_idx" ON "AllianceWeek"("weekStart");

-- 2.3 : régions d'alliance
CREATE TABLE "RegionControl" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "region" TEXT NOT NULL,
    "allianceId" TEXT,
    "stations" INTEGER NOT NULL DEFAULT 0,
    "trips" INTEGER NOT NULL DEFAULT 0,
    "since" TIMESTAMP(3),
    "previousId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegionControl_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegionControl_weekStart_region_key" ON "RegionControl"("weekStart", "region");
CREATE INDEX "RegionControl_allianceId_idx" ON "RegionControl"("allianceId");

-- Boosters du serveur Discord
ALTER TABLE "User" ADD COLUMN "boostSince" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "boostDays" INTEGER NOT NULL DEFAULT 0;
