-- 2.7 : enchères de gares
CREATE TABLE "StationAuction" (
    "station" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "forUntil" TIMESTAMP(3) NOT NULL,
    "minPrice" INTEGER NOT NULL,
    "bestBid" INTEGER,
    "bestId" TEXT,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "StationAuction_pkey" PRIMARY KEY ("station")
);
CREATE INDEX "StationAuction_closedAt_endsAt_idx" ON "StationAuction"("closedAt", "endsAt");
