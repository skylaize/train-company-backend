-- Version 1.2.0 (suite) — donneurs d'ordre, missions et choix d'habillage
-- Deux tables nouvelles, aucune colonne touchée sur l'existant :
-- cette migration ne peut pas perdre de données.

-- Relation commerciale avec un donneur d'ordre.
CREATE TABLE "ClientRelation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "reputation" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 0,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "ClientRelation_pkey" PRIMARY KEY ("id")
);

-- une seule relation par couple (compagnie, client)
CREATE UNIQUE INDEX "ClientRelation_companyId_clientId_key"
    ON "ClientRelation"("companyId", "clientId");

ALTER TABLE "ClientRelation"
    ADD CONSTRAINT "ClientRelation_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ordre de mission proposé par un donneur d'ordre.
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "cargoType" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "reward" INTEGER NOT NULL,
    "repReward" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSEE',
    "offerUntil" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- la boucle de simulation interroge les ordres par compagnie et par statut
CREATE INDEX "Mission_companyId_status_idx" ON "Mission"("companyId", "status");

ALTER TABLE "Mission"
    ADD CONSTRAINT "Mission_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Choix d'habillage de l'interface, mémorisé sur le compte.
ALTER TABLE "Company" ADD COLUMN "theme" TEXT NOT NULL DEFAULT 'sombre';

-- Dernier bulletin de nouveautés lu. Mémorisé sur le compte plutôt que dans le
-- navigateur : sinon le bulletin réapparaît à chaque changement d'appareil.
ALTER TABLE "Company" ADD COLUMN "lastSeenVersion" TEXT;
