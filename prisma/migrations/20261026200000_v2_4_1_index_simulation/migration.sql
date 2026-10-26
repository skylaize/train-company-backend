-- 2.4.1 : index pour la simulation. Postgres n'indexe pas les clés étrangères
-- tout seul : chaque requête de la simulation sur les rames, les lignes, les
-- contrats ou les incidents lisait la table entière.
-- (Sur une grosse table Incident, la création peut prendre quelques secondes.)

CREATE INDEX IF NOT EXISTS "Line_companyId_idx" ON "Line"("companyId");

CREATE INDEX IF NOT EXISTS "Train_companyId_idx" ON "Train"("companyId");
CREATE INDEX IF NOT EXISTS "Train_status_lineId_idx" ON "Train"("status", "lineId");
CREATE INDEX IF NOT EXISTS "Train_lineId_idx" ON "Train"("lineId");

CREATE INDEX IF NOT EXISTS "Contract_status_companyId_idx" ON "Contract"("status", "companyId");
CREATE INDEX IF NOT EXISTS "Contract_companyId_idx" ON "Contract"("companyId");

CREATE INDEX IF NOT EXISTS "Incident_trainId_idx" ON "Incident"("trainId");

CREATE INDEX IF NOT EXISTS "Staff_trainId_idx" ON "Staff"("trainId");
