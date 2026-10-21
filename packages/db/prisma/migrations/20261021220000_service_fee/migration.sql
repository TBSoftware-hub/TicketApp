-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "feeReturnDueCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "feeReturnTriedAt" TIMESTAMP(3),
ADD COLUMN     "platformFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "serviceFeeCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "serviceFeePaidBy" "FeePayer" NOT NULL DEFAULT 'BUYER';

