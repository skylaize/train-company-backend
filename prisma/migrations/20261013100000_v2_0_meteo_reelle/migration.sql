-- 2.0 : la vraie météo de chaque gare
CREATE TABLE IF NOT EXISTS "StationWeather" (
    "station" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "temp" DOUBLE PRECISION NOT NULL,
    "wind" DOUBLE PRECISION NOT NULL,
    "isDay" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StationWeather_pkey" PRIMARY KEY ("station")
);
-- les épisodes inventés en cours s'arrêtent
UPDATE "WeatherEvent" SET "endsAt" = CURRENT_TIMESTAMP WHERE "endsAt" > CURRENT_TIMESTAMP;
