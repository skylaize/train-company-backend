-- 2.1 : l'atelier de prestige (sons, habillage des gares, tenues, plaques des rames, livrée d'alliance)
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "soundPack" TEXT;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "stationSkin" TEXT;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "uniform" TEXT;
ALTER TABLE "Train" ADD COLUMN IF NOT EXISTS "plateStyle" TEXT;
ALTER TABLE "Alliance" ADD COLUMN IF NOT EXISTS "livery" TEXT;
