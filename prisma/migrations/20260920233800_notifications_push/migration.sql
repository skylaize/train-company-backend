-- Notifications push : un enregistrement par appareil abonné.
--
-- L'endpoint fourni par le navigateur sert de clé unique : c'est lui qui
-- identifie l'abonnement côté service de notification, et le même appareil
-- réabonné en produit un nouveau.

CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_companyId_idx" ON "PushSubscription"("companyId");

ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
