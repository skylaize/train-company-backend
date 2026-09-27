-- 1.5 : appels d'offres hebdomadaires

CREATE TABLE "Tender" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "region" TEXT NOT NULL,
    "stationA" TEXT NOT NULL,
    "stationB" TEXT NOT NULL,
    "budgetPerDay" INTEGER NOT NULL,
    "tripsRequired" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ANNONCE',
    "winnerId" TEXT,
    "winningBid" INTEGER,
    "activeTicks" INTEGER NOT NULL DEFAULT 0,
    "paidTicks" INTEGER NOT NULL DEFAULT 0,
    "paidTotal" INTEGER NOT NULL DEFAULT 0,
    "trips" INTEGER NOT NULL DEFAULT 0,
    "objectiveMet" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tender_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Tender_weekStart_stationA_stationB_key" ON "Tender"("weekStart", "stationA", "stationB");
CREATE INDEX "Tender_status_idx" ON "Tender"("status");
CREATE INDEX "Tender_weekStart_idx" ON "Tender"("weekStart");

CREATE TABLE "TenderBid" (
    "id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenderId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "TenderBid_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenderBid_tenderId_companyId_key" ON "TenderBid"("tenderId", "companyId");
ALTER TABLE "TenderBid" ADD CONSTRAINT "TenderBid_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenderBid" ADD CONSTRAINT "TenderBid_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
