-- 2.0 : les épaves à restaurer
ALTER TABLE "Train" ADD COLUMN IF NOT EXISTS "heritage" JSONB;

CREATE TABLE IF NOT EXISTS "Wreck" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rarity" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "retiredYear" INTEGER NOT NULL,
    "history" TEXT NOT NULL,
    "damage" JSONB NOT NULL,
    "restored" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "working" TEXT,
    "workUntil" TIMESTAMP(3),
    "price" INTEGER NOT NULL,
    "spent" INTEGER NOT NULL DEFAULT 0,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "companyId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "trainId" TEXT,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "Wreck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Wreck_companyId_idx" ON "Wreck"("companyId");
CREATE INDEX IF NOT EXISTS "Wreck_expiresAt_idx" ON "Wreck"("expiresAt");
DO $$ BEGIN
  ALTER TABLE "Wreck" ADD CONSTRAINT "Wreck_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
