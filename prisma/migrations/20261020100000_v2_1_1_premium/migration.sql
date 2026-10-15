-- 2.1.1 (Premium) : horaires par rame et alertes personnalisées
ALTER TABLE "Train" ADD COLUMN "serviceFrom" INTEGER;
ALTER TABLE "Train" ADD COLUMN "serviceTo" INTEGER;

CREATE TABLE "CustomAlert" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "targetId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lastKey" TEXT,
    "firedAt" TIMESTAMP(3),
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "CustomAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomAlert_companyId_idx" ON "CustomAlert"("companyId");

ALTER TABLE "CustomAlert" ADD CONSTRAINT "CustomAlert_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
