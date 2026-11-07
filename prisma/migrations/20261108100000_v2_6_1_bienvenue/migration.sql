-- 2.6.1 : contrat de bienvenue, réservé 24 h à une nouvelle compagnie
ALTER TABLE "Contract" ADD COLUMN "reservedFor" TEXT;
