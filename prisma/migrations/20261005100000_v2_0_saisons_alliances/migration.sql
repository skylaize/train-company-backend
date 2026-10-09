-- 2.0 : saisons, alliances, Grand Chantier
ALTER TABLE "Company" ADD COLUMN "division" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Season_number_key" ON "Season"("number");

CREATE TABLE "SeasonEntry" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "division" INTEGER NOT NULL,
    "groupNo" INTEGER NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "rankYesterday" INTEGER,
    "finalRank" INTEGER,
    "outcome" TEXT,
    "rewarded" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeasonEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SeasonEntry_seasonId_companyId_key" ON "SeasonEntry"("seasonId", "companyId");
CREATE INDEX "SeasonEntry_seasonId_division_groupNo_idx" ON "SeasonEntry"("seasonId", "division", "groupNo");

CREATE TABLE "SeasonObjectiveProgress" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    CONSTRAINT "SeasonObjectiveProgress_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SeasonObjectiveProgress_seasonId_week_kind_companyId_key" ON "SeasonObjectiveProgress"("seasonId", "week", "kind", "companyId");

CREATE TABLE "Alliance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#f59e0b',
    "discordUrl" TEXT,
    "founderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Alliance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Alliance_name_key" ON "Alliance"("name");

CREATE TABLE "AllianceMember" (
    "id" TEXT NOT NULL,
    "allianceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AllianceMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AllianceMember_companyId_key" ON "AllianceMember"("companyId");
CREATE INDEX "AllianceMember_allianceId_idx" ON "AllianceMember"("allianceId");

CREATE TABLE "AllianceInvite" (
    "id" TEXT NOT NULL,
    "allianceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AllianceInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AllianceInvite_allianceId_companyId_key" ON "AllianceInvite"("allianceId", "companyId");

CREATE TABLE "AllianceMessage" (
    "id" TEXT NOT NULL,
    "allianceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AllianceMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AllianceMessage_allianceId_createdAt_idx" ON "AllianceMessage"("allianceId", "createdAt");

CREATE TABLE "WorldProject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "WorldProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorldContribution" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "WorldContribution_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorldContribution_projectId_companyId_key" ON "WorldContribution"("projectId", "companyId");
