-- CreateEnum
CREATE TYPE "FeePayer" AS ENUM ('BUYER', 'ORGANIZATION');

-- AlterEnum
ALTER TYPE "TicketStatus" ADD VALUE 'HELD';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "holdExpiresAt" TIMESTAMP(3),
ADD COLUMN     "processingFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stripeCheckoutSessionId" TEXT,
ADD COLUMN     "viewKeyHash" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "cardFeePaidBy" "FeePayer" NOT NULL DEFAULT 'ORGANIZATION';

-- CreateIndex
CREATE UNIQUE INDEX "Order_viewKeyHash_key" ON "Order"("viewKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "Order_stripeCheckoutSessionId_key" ON "Order"("stripeCheckoutSessionId");

