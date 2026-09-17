-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "maxTrains" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "expiresAt" TIMESTAMP(3);
