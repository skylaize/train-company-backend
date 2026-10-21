-- 2.1.2 : les requêtes par type de transaction (succès, défis, résumé du
-- jour, statistiques de la page d'accueil) parcouraient toute la table.
CREATE INDEX IF NOT EXISTS "Transaction_companyId_type_createdAt_idx" ON "Transaction"("companyId", "type", "createdAt");
CREATE INDEX IF NOT EXISTS "Transaction_type_createdAt_idx" ON "Transaction"("type", "createdAt");
