-- Ajouts de la version 1.1.0
-- Écrit à la main pour préserver les compagnies déjà en base : "referralCode"
-- est une colonne obligatoire et unique, qu'une migration générée ne saurait
-- pas remplir pour les lignes existantes (elle proposerait de vider la base).

-- ── 1. Tutoriel mémorisé sur le compte ──
ALTER TABLE "Company" ADD COLUMN "tutorialSeen" BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Parrainage ──
ALTER TABLE "Company" ADD COLUMN "referralRewardGranted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Company" ADD COLUMN "referredById" TEXT;

-- la colonne est d'abord facultative, le temps de donner un code à chaque compagnie existante
ALTER TABLE "Company" ADD COLUMN "referralCode" TEXT;

UPDATE "Company"
SET "referralCode" = upper(substr(md5(random()::text || "id" || clock_timestamp()::text), 1, 6))
WHERE "referralCode" IS NULL;

ALTER TABLE "Company" ALTER COLUMN "referralCode" SET NOT NULL;
CREATE UNIQUE INDEX "Company_referralCode_key" ON "Company"("referralCode");

ALTER TABLE "Company" ADD CONSTRAINT "Company_referredById_fkey"
  FOREIGN KEY ("referredById") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. Assurance fret ──
ALTER TABLE "Contract" ADD COLUMN "insured" BOOLEAN NOT NULL DEFAULT false;

-- ── 4. Succès acquis définitivement ──
CREATE TABLE "AchievementUnlock" (
  "id" TEXT NOT NULL,
  "achievementId" TEXT NOT NULL,
  "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "companyId" TEXT NOT NULL,
  CONSTRAINT "AchievementUnlock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AchievementUnlock_companyId_achievementId_key"
  ON "AchievementUnlock"("companyId", "achievementId");
ALTER TABLE "AchievementUnlock" ADD CONSTRAINT "AchievementUnlock_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 5. Publicités récompensées (fonctionnalité désactivée, mais la table doit exister) ──
CREATE TABLE "AdWatch" (
  "id" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "companyId" TEXT NOT NULL,
  CONSTRAINT "AdWatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdWatch_companyId_date_key" ON "AdWatch"("companyId", "date");
ALTER TABLE "AdWatch" ADD CONSTRAINT "AdWatch_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
