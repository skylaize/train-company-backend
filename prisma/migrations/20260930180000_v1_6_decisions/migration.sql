-- 1.6 : décisions du directeur
ALTER TABLE "Company" ADD COLUMN "reputationAdjust" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Company" ADD COLUMN "nextDecisionAt" TIMESTAMP(3);

CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "place" TEXT,
    "data" JSONB,
    "choices" JSONB NOT NULL,
    "defaultChoiceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OUVERTE',
    "chosenId" TEXT,
    "outcome" TEXT,
    "effectKey" TEXT,
    "effectMultiplier" DOUBLE PRECISION,
    "effectEndsAt" TIMESTAMP(3),
    "goalStation" TEXT,
    "goalReward" INTEGER,
    "goalDeadline" TIMESTAMP(3),
    "goalDone" BOOLEAN NOT NULL DEFAULT false,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Decision_companyId_status_idx" ON "Decision"("companyId", "status");
CREATE INDEX "Decision_status_expiresAt_idx" ON "Decision"("status", "expiresAt");
CREATE INDEX "Decision_effectEndsAt_idx" ON "Decision"("effectEndsAt");

ALTER TABLE "Decision" ADD CONSTRAINT "Decision_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
