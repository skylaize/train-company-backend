-- 2.7.1 : les sous-stations se réparaient trop vite. L'éruption en cours
-- passe au nouveau prix (×2,5) ; celles déjà réparées le restent.
UPDATE "SubStation" SET "cost" = ROUND("cost" * 2.5) WHERE "repairedAt" IS NULL;

-- 2.7.1 : l'éruption en cours accélère, une région toutes les 40 min (au lieu
-- de 2 h) et 40 min de courant faible avant la coupure.
UPDATE "GameSetting"
SET "value" = jsonb_set(jsonb_set("value"::jsonb, '{stepMinutes}', '40'::jsonb), '{reducedMinutes}', '40'::jsonb), "updatedAt" = now()
WHERE "key" = 'eruption';
