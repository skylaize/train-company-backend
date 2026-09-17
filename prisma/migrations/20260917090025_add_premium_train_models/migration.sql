-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "isPremium" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Train" ADD COLUMN     "model" TEXT NOT NULL DEFAULT 'STANDARD';
