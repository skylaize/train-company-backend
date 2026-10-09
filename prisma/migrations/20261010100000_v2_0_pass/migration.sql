-- 2.0 : Pass de saison, paliers gratuits réclamés
CREATE TABLE "SeasonPassClaim" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeasonPassClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SeasonPassClaim_seasonId_companyId_tier_key" ON "SeasonPassClaim"("seasonId", "companyId", "tier");
