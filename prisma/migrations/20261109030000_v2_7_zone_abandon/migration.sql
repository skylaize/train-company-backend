-- 2.7 : la zone d'abandon (rames de collection revendues ou mises à la casse)
ALTER TABLE "Wreck" ADD COLUMN "abandonedAt" TIMESTAMP(3);
ALTER TABLE "Wreck" ADD COLUMN "abandonedBy" TEXT;
