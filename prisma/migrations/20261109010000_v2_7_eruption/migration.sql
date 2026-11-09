-- 2.7 : éruption solaire
ALTER TABLE "Company" ADD COLUMN "voltPoints" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Contract" ADD COLUMN "electric" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "SubStation" (
    "region" TEXT NOT NULL,
    "cost" INTEGER NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "repairedAt" TIMESTAMP(3),
    "auto" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "SubStation_pkey" PRIMARY KEY ("region")
);

CREATE TABLE "SubStationGift" (
    "region" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubStationGift_pkey" PRIMARY KEY ("region","companyId")
);
CREATE INDEX "SubStationGift_companyId_idx" ON "SubStationGift"("companyId");

-- 2.7 : quête de fin de saison
CREATE TABLE "SeasonQuest" (
    "seasonId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    CONSTRAINT "SeasonQuest_pkey" PRIMARY KEY ("seasonId","companyId")
);
