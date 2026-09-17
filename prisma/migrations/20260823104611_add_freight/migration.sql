-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DISPONIBLE', 'EN_COURS', 'LIVREE');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "balance" INTEGER NOT NULL DEFAULT 500;

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "cargoType" TEXT NOT NULL,
    "originStation" TEXT NOT NULL,
    "destinationStation" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "reward" INTEGER NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'DISPONIBLE',
    "acceptedAt" TIMESTAMP(3),
    "companyId" TEXT,
    "trainId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Contract_trainId_key" ON "Contract"("trainId");

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_trainId_fkey" FOREIGN KEY ("trainId") REFERENCES "Train"("id") ON DELETE SET NULL ON UPDATE CASCADE;
