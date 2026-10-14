-- 2.1 : double voie et gares de triage
ALTER TABLE "Line" ADD COLUMN "doubleTrack" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Yard" (
    "id" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "Yard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Yard_companyId_station_key" ON "Yard"("companyId", "station");

ALTER TABLE "Yard" ADD CONSTRAINT "Yard_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
