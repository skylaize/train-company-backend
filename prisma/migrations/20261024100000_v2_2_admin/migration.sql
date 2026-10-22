-- 2.2 : panneau d'administration
ALTER TABLE "User" ADD COLUMN "bannedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "bannedReason" TEXT;

CREATE TABLE "AdminAction" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "adminName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "target" TEXT,
    "details" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminAction_createdAt_idx" ON "AdminAction"("createdAt");
CREATE INDEX "AdminAction_targetId_idx" ON "AdminAction"("targetId");

CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imageUrl" TEXT,
    "channel" TEXT NOT NULL,
    "ping" TEXT,
    "igCaption" TEXT NOT NULL DEFAULT '',
    "discordKey" TEXT,
    "pushSent" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Announcement_createdAt_idx" ON "Announcement"("createdAt");
