-- v1.4 — Gares vivantes et concurrence sur les lignes.

CREATE TABLE "StationEvent" (
  "id" TEXT NOT NULL,
  "station" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "multiplier" DOUBLE PRECISION NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StationEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StationEvent_endsAt_idx" ON "StationEvent"("endsAt");

ALTER TABLE "Line" ADD COLUMN "rivals" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Line" ADD COLUMN "leading" BOOLEAN NOT NULL DEFAULT true;

-- Boutique : matériel de collection affiché dans la vue cabine.
ALTER TABLE "Company" ADD COLUMN "cabSkin" TEXT;
