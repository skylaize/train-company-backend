-- Version 1.2.0 (suite) — explications contextuelles
-- Chaque nouveauté (donneurs d'ordre, carte, classement) s'explique la première
-- fois que le joueur ouvre sa page. Comme le bulletin de nouveautés, c'est
-- mémorisé sur le compte et non dans le navigateur : sinon l'explication
-- réapparaît à chaque changement d'appareil.
ALTER TABLE "Company" ADD COLUMN "hintsSeen" TEXT NOT NULL DEFAULT '';
