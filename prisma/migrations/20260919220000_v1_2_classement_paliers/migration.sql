-- Version 1.2.0 — paliers de parrainage
-- Deux colonnes seulement : le classement, lui, est entièrement calculé à la volée
-- et ne demande aucun changement de schéma.

-- plus haut palier de parrainage déjà accordé (0, puis 3, 5, 10)
ALTER TABLE "Company" ADD COLUMN "referralMilestone" INTEGER NOT NULL DEFAULT 0;

-- titre honorifique gagné au palier de 5 filleuls, affiché au classement
ALTER TABLE "Company" ADD COLUMN "title" TEXT;
