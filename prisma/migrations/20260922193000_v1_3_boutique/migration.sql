-- v1.3 — Boutique d'objets cosmétiques.
--
-- Une colonne pour l'emblème porté, une table pour les achats. Aucune colonne
-- existante n'est modifiée : le titre de parrainage déjà accordé reste en place.

ALTER TABLE "Company" ADD COLUMN "emblem" TEXT;

CREATE TABLE "ShopPurchase" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "stripeSessionId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "ShopPurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopPurchase_stripeSessionId_key" ON "ShopPurchase"("stripeSessionId");
CREATE UNIQUE INDEX "ShopPurchase_companyId_itemId_key" ON "ShopPurchase"("companyId", "itemId");

ALTER TABLE "ShopPurchase" ADD CONSTRAINT "ShopPurchase_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
