-- 1.7.2 : délai de grâce pour le personnel impayé
ALTER TABLE "Staff" ADD COLUMN "unpaidTicks" INTEGER NOT NULL DEFAULT 0;

-- 1.7.2 : un seul serveur fait tourner la simulation
CREATE TABLE "SimLease" (
    "id" INTEGER NOT NULL,
    "holder" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SimLease_pkey" PRIMARY KEY ("id")
);

-- rames restées « en panne » à 0 % d'usure : on les libère
UPDATE "Train" SET "status" = 'EN_ROUTE', "progress" = 0, "departedAt" = NOW()
  WHERE "status" = 'MAINTENANCE' AND "wear" < 100 AND "lineId" IS NOT NULL;
UPDATE "Train" SET "status" = 'IDLE', "progress" = 0, "departedAt" = NULL
  WHERE "status" = 'MAINTENANCE' AND "wear" < 100 AND "lineId" IS NULL;
