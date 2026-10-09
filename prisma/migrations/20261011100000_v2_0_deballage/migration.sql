-- 2.0 : l'animation de déballage après un achat ou un cadeau
ALTER TABLE "ShopPurchase" ADD COLUMN IF NOT EXISTS "giftFrom" TEXT;
ALTER TABLE "ShopPurchase" ADD COLUMN IF NOT EXISTS "revealedAt" TIMESTAMP(3);
-- les achats d'avant la mise à jour ne rejouent pas d'animation
UPDATE "ShopPurchase" SET "revealedAt" = CURRENT_TIMESTAMP WHERE "revealedAt" IS NULL;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "premiumReveal" TEXT;
