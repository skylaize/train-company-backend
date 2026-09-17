-- AlterTable
ALTER TABLE "Train" ADD COLUMN     "wear" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "trainId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_trainId_fkey" FOREIGN KEY ("trainId") REFERENCES "Train"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
