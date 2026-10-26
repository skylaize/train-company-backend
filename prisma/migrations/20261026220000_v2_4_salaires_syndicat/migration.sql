-- 2.4 : la hausse de 10 % accordée au syndicat devient temporaire (4 jours).
-- Les hausses déjà accordées duraient pour toujours au niveau 5 et
-- s'empilaient : tout salaire au-dessus de celui de son niveau y revient.
-- Même formule que salaryFor (staff.service) : base × (1 + 0,25 × (niveau − 1)), arrondi.
UPDATE "Staff" AS s
SET "salaryPerTick" = b.salary
FROM (
  SELECT st."id", ROUND(base.v * (1 + 0.25 * (st."level" - 1)))::int AS salary
  FROM "Staff" st
  JOIN (VALUES ('MECANICIEN', 3::numeric), ('CHEF_DEPOT', 4), ('CONTROLEUR', 2), ('CONDUCTEUR', 3), ('DIRECTEUR_COMMERCIAL', 6)) AS base(role, v)
    ON base.role = st."role"
) AS b
WHERE s."id" = b."id" AND s."salaryPerTick" > b.salary;
