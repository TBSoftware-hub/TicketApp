-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "confirmationSentAt" TIMESTAMP(3),
ADD COLUMN     "emailViewKey" TEXT;

