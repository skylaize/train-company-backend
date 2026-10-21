-- 2.1.2 : le Train des 200
CREATE TABLE "SpecialTrain" (
    "id" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "route" JSONB NOT NULL,
    "lastStop" INTEGER NOT NULL DEFAULT -1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpecialTrain_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SpecialTrainVisit" (
    "id" TEXT NOT NULL,
    "trainId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "reward" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpecialTrainVisit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SpecialTrainVisit_trainId_companyId_key" ON "SpecialTrainVisit"("trainId", "companyId");
CREATE INDEX "SpecialTrainVisit_trainId_at_idx" ON "SpecialTrainVisit"("trainId", "at");
