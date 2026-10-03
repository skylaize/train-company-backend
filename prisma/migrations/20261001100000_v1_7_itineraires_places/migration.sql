-- 1.7 : arrêts, prix du billet, électrification ; sens de marche et composition des rames
ALTER TABLE "Line" ADD COLUMN "stops" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Line" ADD COLUMN "priceRatio" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "Line" ADD COLUMN "electrified" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Train" ADD COLUMN "direction" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Train" ADD COLUMN "cars" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Train" ADD COLUMN "lastPassengers" INTEGER;
ALTER TABLE "Train" ADD COLUMN "lastSeats" INTEGER;
