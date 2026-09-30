-- 1.6 : lignes internationales et trains de nuit
-- (la date d'application de cette migration fixe aussi l'ouverture de la licence à tous : une semaine après)
ALTER TABLE "Company" ADD COLUMN "intlLicenceAt" TIMESTAMP(3);
