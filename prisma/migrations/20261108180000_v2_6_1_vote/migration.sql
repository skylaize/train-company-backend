-- 2.6.1 : vote Top-Serveurs récompensé une fois par jour
ALTER TABLE "Company" ADD COLUMN "voteStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Company" ADD COLUMN "lastVoteDay" TEXT;

CREATE TABLE "VoteReward" (
    "companyId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "streak" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoteReward_pkey" PRIMARY KEY ("companyId","day")
);

ALTER TABLE "VoteReward" ADD CONSTRAINT "VoteReward_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
