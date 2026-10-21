-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "doorSaleKey" UUID,
ADD COLUMN     "soldById" UUID,
ALTER COLUMN "buyerEmail" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Order_doorSaleKey_key" ON "Order"("doorSaleKey");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_soldById_fkey" FOREIGN KEY ("soldById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
