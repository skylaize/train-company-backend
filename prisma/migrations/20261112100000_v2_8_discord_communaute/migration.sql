-- 2.8 : espaces d'alliance sur Discord, quiz du jour
CREATE TABLE "DiscordAllianceSpace" (
    "allianceId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "founderDiscordId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordAllianceSpace_pkey" PRIMARY KEY ("allianceId")
);

CREATE TABLE "DiscordQuiz" (
    "day" TEXT NOT NULL,
    "questionIdx" INTEGER NOT NULL,
    "channelId" TEXT NOT NULL DEFAULT '',
    "messageId" TEXT NOT NULL DEFAULT '',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordQuiz_pkey" PRIMARY KEY ("day")
);

CREATE TABLE "DiscordQuizAnswer" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "choice" INTEGER NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordQuizAnswer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscordQuizAnswer_day_discordId_key" ON "DiscordQuizAnswer"("day", "discordId");
CREATE INDEX "DiscordQuizAnswer_discordId_idx" ON "DiscordQuizAnswer"("discordId");
CREATE INDEX "DiscordQuizAnswer_createdAt_idx" ON "DiscordQuizAnswer"("createdAt");
