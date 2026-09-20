-- Version 1.2.0 (suite) — durées de trajet calculées depuis la distance réelle
--
-- Le rendement d'une ligne croît désormais avec sa longueur. Laisser les lignes
-- existantes avec une durée saisie à la main créerait une injustice durable :
-- une Paris–Chartres réglée à 30 minutes rapporterait plus que n'importe quel
-- tracé créable aujourd'hui. On les recalcule donc toutes, une fois.
--
-- Aucun changement de schéma : seules des valeurs sont mises à jour.

WITH gares(nom, x, y) AS (
  VALUES
    ('Lille', 190.0, 20.0),   ('Le Havre', 128.0, 71.0),  ('Rouen', 146.0, 71.0),
    ('Metz', 260.0, 85.0),    ('Paris', 174.0, 96.0),     ('Nancy', 260.0, 103.0),
    ('Strasbourg', 292.0, 109.0), ('Chartres', 155.0, 114.0), ('Rennes', 84.0, 128.0),
    ('Le Mans', 126.0, 133.0), ('Mulhouse', 286.0, 144.0), ('Dijon', 234.0, 162.0),
    ('Nantes', 87.0, 167.0),  ('Lyon', 230.0, 229.0),     ('Grenoble', 250.0, 254.0),
    ('Bordeaux', 108.0, 269.0), ('Toulouse', 154.0, 322.0), ('Marseille', 242.0, 335.0)
),
-- projection inverse : on remonte des unités de carte aux degrés
degres AS (
  SELECT nom,
         3.06 + (x - 190) / 22.4  AS lon,
         50.63 - (y - 20) / 42.97 AS lat
  FROM gares
),
-- distance équirectangulaire, en kilomètres
calcul AS (
  SELECT l.id,
         sqrt(
           power((b.lon - a.lon) * 111.32 * cos(radians((a.lat + b.lat) / 2)), 2) +
           power((b.lat - a.lat) * 110.57, 2)
         ) AS km
  FROM "Line" l
  JOIN degres a ON a.nom = l."departureStation"
  JOIN degres b ON b.nom = l."arrivalStation"
)
UPDATE "Line" l
SET "durationMinutes" = GREATEST(3, LEAST(20, round(c.km / 55)::int))
FROM calcul c
WHERE c.id = l.id;

-- Les lignes dont une gare n'est pas au catalogue gardent leur durée : mieux
-- vaut une incohérence isolée qu'une ligne ramenée à zéro.
