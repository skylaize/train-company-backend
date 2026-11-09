-- 2.7 : habillage des locomotives de fret (vue cabine)
ALTER TABLE "Company" ADD COLUMN "freightSkin" TEXT;

-- 2.7 : la boutique passe à l'Intercités carmillon. Les achats d'avant cette
-- date gardent l'Intercités à leurs couleurs.
INSERT INTO "GameSetting" ("key", "value", "updatedAt")
VALUES ('intercitesSwitch', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), now())
ON CONFLICT ("key") DO NOTHING;
ALTER TABLE "Company" ADD COLUMN "powerOfferPct" INTEGER;
