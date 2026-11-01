-- 2.5 : campagnes régionales et compagnonnage
ALTER TABLE "Company" ADD COLUMN "mentorOpen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Company" ADD COLUMN "mentorPitch" TEXT;

CREATE TABLE "RegionCampaign" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stepStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "RegionCampaign_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegionCampaign_companyId_region_key" ON "RegionCampaign"("companyId", "region");
CREATE INDEX "RegionCampaign_companyId_active_idx" ON "RegionCampaign"("companyId", "active");

CREATE TABLE "Mentorship" (
    "id" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "apprenticeId" TEXT NOT NULL,
    "gradeReached" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Mentorship_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Mentorship_mentorId_endedAt_idx" ON "Mentorship"("mentorId", "endedAt");
CREATE INDEX "Mentorship_apprenticeId_endedAt_idx" ON "Mentorship"("apprenticeId", "endedAt");

CREATE TABLE "MentorNote" (
    "id" TEXT NOT NULL,
    "mentorshipId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MentorNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MentorNote_mentorshipId_createdAt_idx" ON "MentorNote"("mentorshipId", "createdAt");
