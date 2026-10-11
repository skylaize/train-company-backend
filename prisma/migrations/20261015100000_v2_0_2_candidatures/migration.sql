-- 2.0.2 : candidatures d'alliance
ALTER TABLE "Alliance" ADD COLUMN IF NOT EXISTS "recruiting" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Alliance" ADD COLUMN IF NOT EXISTS "pitch" TEXT;
ALTER TABLE "AllianceMember" ADD COLUMN IF NOT EXISTS "viaApplication" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "AllianceApplication" (
    "id" TEXT NOT NULL,
    "allianceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AllianceApplication_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AllianceApplication_allianceId_companyId_key" ON "AllianceApplication"("allianceId", "companyId");
CREATE INDEX IF NOT EXISTS "AllianceApplication_companyId_idx" ON "AllianceApplication"("companyId");
