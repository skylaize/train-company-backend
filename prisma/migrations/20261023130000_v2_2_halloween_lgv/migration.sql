-- 2.2 : lignes à grande vitesse
ALTER TABLE "Line" ADD COLUMN "highSpeedAt" TIMESTAMP(3);
ALTER TABLE "Line" ADD COLUMN "highSpeedCost" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Line" ADD COLUMN "highSpeedNotified" BOOLEAN NOT NULL DEFAULT false;

-- 2.2 : Halloween, les âmes du Train fantôme
CREATE TABLE "HalloweenSoul" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "companyId" TEXT NOT NULL,
    "souls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HalloweenSoul_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HalloweenSoul_year_companyId_key" ON "HalloweenSoul"("year", "companyId");
CREATE INDEX "HalloweenSoul_year_souls_idx" ON "HalloweenSoul"("year", "souls");
