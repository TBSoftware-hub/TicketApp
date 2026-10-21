-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cancellationEmail" JSONB,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" UUID,
ADD COLUMN     "refundedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stripeRefundId" TEXT,
ADD COLUMN     "stripeRefundStatus" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_stripeRefundId_key" ON "Order"("stripeRefundId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

