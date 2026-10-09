-- 2.0 : l'atelier (organes, casse, pièces, révision programmée)
ALTER TABLE "Train" ADD COLUMN "organs" JSONB;
ALTER TABLE "Train" ADD COLUMN "brokenPart" TEXT;
ALTER TABLE "Train" ADD COLUMN "partsEta" TIMESTAMP(3);
ALTER TABLE "Train" ADD COLUMN "workshopUntil" TIMESTAMP(3);
ALTER TABLE "Train" ADD COLUMN "serviceAt" INTEGER;

-- 2.0 : équipages affectés aux rames
ALTER TABLE "Staff" ADD COLUMN "trainId" TEXT;

-- 2.0 : magasin de pièces détachées
ALTER TABLE "Company" ADD COLUMN "partsStock" JSONB NOT NULL DEFAULT '{}';

-- 2.0 : suites des décisions
CREATE TABLE "DecisionFollowUp" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionFollowUp_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DecisionFollowUp_done_dueAt_idx" ON "DecisionFollowUp"("done", "dueAt");
