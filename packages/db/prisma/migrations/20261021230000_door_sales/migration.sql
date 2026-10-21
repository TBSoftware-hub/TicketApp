-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "soldById" UUID,
ALTER COLUMN "buyerEmail" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_soldById_fkey" FOREIGN KEY ("soldById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

