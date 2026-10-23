-- AlterTable
ALTER TABLE "ScanEvent" ADD COLUMN     "offlineAt" TIMESTAMP(3),
ADD COLUMN     "offlineAnswer" JSONB;
