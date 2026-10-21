-- 2.1.2 : les 200 pionniers. Le numéro suit l'ordre de fondation et ne bouge
-- plus ensuite, même si une compagnie plus ancienne est supprimée.
ALTER TABLE "Company" ADD COLUMN "pioneerNumber" INTEGER;
CREATE UNIQUE INDEX "Company_pioneerNumber_key" ON "Company"("pioneerNumber");

UPDATE "Company" AS c
SET "pioneerNumber" = r.n
FROM (SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS n FROM "Company") AS r
WHERE c."id" = r."id" AND r.n <= 200;
