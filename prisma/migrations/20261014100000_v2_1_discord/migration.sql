-- 2.1 : liaison Discord
ALTER TABLE "User" ADD COLUMN "discordId" TEXT;
ALTER TABLE "User" ADD COLUMN "discordName" TEXT;
CREATE UNIQUE INDEX "User_discordId_key" ON "User"("discordId");

CREATE TABLE "DiscordPost" (
    "key" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordPost_pkey" PRIMARY KEY ("key")
);
