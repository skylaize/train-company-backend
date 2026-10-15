-- 2.1 : Premium d'essai
ALTER TABLE "Company" ADD COLUMN "premiumTrialUntil" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "premiumTrialEndedAt" TIMESTAMP(3);
