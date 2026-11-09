-- 2.7 : fret automatique (joueurs absents)
ALTER TABLE "Train" ADD COLUMN "autoFreight" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contract" ADD COLUMN "auto" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contract" ADD COLUMN "autoTrain" TEXT;
CREATE INDEX "Contract_autoTrain_acceptedAt_idx" ON "Contract"("autoTrain", "acceptedAt");
