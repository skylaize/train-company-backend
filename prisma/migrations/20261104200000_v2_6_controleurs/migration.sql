-- 2.6 : le contrôleur coûte deux fois moins (salaire de base 1 pièce par tour au lieu de 2)
UPDATE "Staff" SET "salaryPerTick" = GREATEST(1, ROUND(1 * (1 + 0.25 * ("level" - 1))))::int WHERE "role" = 'CONTROLEUR';
