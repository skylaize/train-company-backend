-- v1.3 — Personnel nommé, expérimenté, et plusieurs employés par poste.
--
-- Rien n'est perdu pour les employés déjà en place : ils reçoivent un nom,
-- et leur ancienneté est convertie en expérience. Ils restent au niveau 1 ;
-- leurs demandes d'augmentation apparaîtront d'elles-mêmes au tour suivant,
-- ce qui présente le nouveau système au joueur au lieu de le lui imposer.

-- Plusieurs employés par poste : l'unicité (compagnie, poste) disparaît.
DROP INDEX IF EXISTS "Staff_companyId_role_key";

ALTER TABLE "Staff" ADD COLUMN "name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Staff" ADD COLUMN "level" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Staff" ADD COLUMN "xp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Staff" ADD COLUMN "raiseRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Staff" ADD COLUMN "refusedAtXp" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Staff_companyId_role_idx" ON "Staff"("companyId", "role");

-- Ancienneté → expérience : un point par tranche de 30 secondes de service,
-- plafonné à une semaine (le seuil du dernier niveau).
UPDATE "Staff"
SET "xp" = LEAST(20160, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - "hiredAt")) / 30)::INTEGER));

-- Un nom pour chacun, tiré dans la même liste que les nouvelles embauches.
UPDATE "Staff"
SET "name" = (
  (ARRAY['Jeanne','Louis','Marcel','Odette','Henri','Simone','Gaston','Lucienne','René','Paulette',
         'André','Germaine','Émile','Yvonne','Raymond','Suzanne','Fernand','Madeleine','Lucien','Marthe'])
    [1 + FLOOR(RANDOM() * 20)::INTEGER]
  || ' ' ||
  (ARRAY['Morel','Garnier','Lefèvre','Roux','Fontaine','Chevalier','Mercier','Blanchard','Gauthier','Perrin',
         'Dubois','Lambert','Bonnet','Faure','Rousseau','Girard','Vidal','Caron','Masson','Renaud'])
    [1 + FLOOR(RANDOM() * 20)::INTEGER]
)
WHERE "name" = '';
