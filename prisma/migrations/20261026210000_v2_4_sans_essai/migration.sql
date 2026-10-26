-- 2.4 : pas de période d'essai pour l'économie du rail.
-- Une première version de la 2.4 ouvrait 14 jours d'essai au démarrage et
-- enregistrait leur date de fin dans les réglages. Si un essai est encore en
-- cours en base, on le retire : au tour suivant, le serveur pose une fin
-- d'essai à maintenant (trialDays vaut 0) et tout est prélevé normalement.
-- L'admin peut toujours ouvrir un essai à la main depuis le panneau.
UPDATE "GameSetting"
SET "value" = ("value" - 'trialUntil' - 'trialDays'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'economy'
  AND "value" ? 'trialUntil'
  AND ("value"->>'trialUntil') IS NOT NULL
  AND ("value"->>'trialUntil')::timestamptz > CURRENT_TIMESTAMP;
