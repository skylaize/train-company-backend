-- 1.6 : « Premiers pas » et les nouveaux conseils sont pour les nouveaux venus.
-- Les compagnies déjà installées les ont d'office comme lus.
UPDATE "Company"
SET "hintsSeen" = CASE
  WHEN "hintsSeen" IS NULL OR "hintsSeen" = '' THEN 'premiers-pas,gares,fret'
  ELSE "hintsSeen" || ',premiers-pas,gares,fret'
END;
