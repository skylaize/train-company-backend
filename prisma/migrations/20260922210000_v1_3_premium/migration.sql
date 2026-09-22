-- v1.3 — Premium : rentabilité détaillée, bilan de retour, file de chantiers.

-- Rentabilité : chaque recette et chaque réparation retient la rame et la ligne.
-- Les écritures antérieures restent sans rame : la page l'indique.
ALTER TABLE "Transaction" ADD COLUMN "trainId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "lineId" TEXT;
CREATE INDEX "Transaction_companyId_createdAt_idx" ON "Transaction"("companyId", "createdAt");

-- Bilan de retour.
ALTER TABLE "Company" ADD COLUMN "lastActiveAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "lastActiveBalance" INTEGER;
ALTER TABLE "Company" ADD COLUMN "absenceFrom" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "absenceTo" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "absenceFromBalance" INTEGER;
ALTER TABLE "Company" ADD COLUMN "absenceToBalance" INTEGER;
ALTER TABLE "Company" ADD COLUMN "lastDigestOn" TEXT;

-- File de chantiers.
ALTER TABLE "Construction" ADD COLUMN "queued" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Construction" ADD COLUMN "durationMs" INTEGER NOT NULL DEFAULT 0;
