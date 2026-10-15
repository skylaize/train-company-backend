-- 2.1 : giveaways Discord
CREATE TABLE "Giveaway" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL DEFAULT '',
    "prizeKind" TEXT NOT NULL,
    "prizeValue" TEXT NOT NULL,
    "winners" INTEGER NOT NULL DEFAULT 1,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "winnerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Giveaway_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Giveaway_endedAt_endsAt_idx" ON "Giveaway"("endedAt", "endsAt");

CREATE TABLE "GiveawayEntry" (
    "id" TEXT NOT NULL,
    "giveawayId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GiveawayEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GiveawayEntry_giveawayId_discordId_key" ON "GiveawayEntry"("giveawayId", "discordId");
