-- 2.0.3 : primes du tutoriel
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "tutorialRewards" TEXT[] DEFAULT ARRAY[]::TEXT[];
