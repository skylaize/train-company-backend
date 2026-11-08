-- Suspension temporaire et avertissements
ALTER TABLE "User" ADD COLUMN "bannedUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "warning" TEXT;
ALTER TABLE "User" ADD COLUMN "warnedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "warnCount" INTEGER NOT NULL DEFAULT 0;
