-- 2.1 : fret et wagons. Une rame peut porter plusieurs contrats (une tournée).
DROP INDEX IF EXISTS "Contract_trainId_key";
CREATE INDEX IF NOT EXISTS "Contract_trainId_idx" ON "Contract"("trainId");
ALTER TABLE "Contract" ADD COLUMN IF NOT EXISTS "tourMinutes" INTEGER;
ALTER TABLE "Contract" ADD COLUMN IF NOT EXISTS "loadFactor" DOUBLE PRECISION NOT NULL DEFAULT 1;
