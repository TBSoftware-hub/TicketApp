-- AlterTable
ALTER TABLE "ScanEvent" ADD COLUMN     "scanKey" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "ScanEvent_scanKey_key" ON "ScanEvent"("scanKey");

