-- 2.4 : les compteurs « depuis toujours » (classement, réputation, bourse)
-- ne relisent plus toute la table : ils ajoutent les lignes arrivées depuis
-- le dernier passage, retrouvées par leur date. Sur une grosse table
-- Transaction, la création peut prendre de quelques secondes à une minute
-- (les écritures attendent pendant ce temps).
CREATE INDEX IF NOT EXISTS "Transaction_createdAt_idx" ON "Transaction"("createdAt");
CREATE INDEX IF NOT EXISTS "Incident_createdAt_idx" ON "Incident"("createdAt");
