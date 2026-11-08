-- Voteurs du mois
CREATE TABLE "VoteMonth" (
    "companyId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "votes" INTEGER NOT NULL DEFAULT 0,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoteMonth_pkey" PRIMARY KEY ("companyId","month")
);
CREATE INDEX "VoteMonth_month_votes_idx" ON "VoteMonth"("month", "votes");

CREATE TABLE "VoteWinner" (
    "month" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "companyId" TEXT NOT NULL,
    "votes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoteWinner_pkey" PRIMARY KEY ("month","rank")
);
CREATE INDEX "VoteWinner_companyId_idx" ON "VoteWinner"("companyId");
