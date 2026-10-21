-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "confirmationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "confirmationClaimedAt" TIMESTAMP(3),
ADD COLUMN     "confirmationEmail" JSONB,
ADD COLUMN     "confirmationFirstTriedAt" TIMESTAMP(3),
ADD COLUMN     "confirmationSentAt" TIMESTAMP(3),
ADD COLUMN     "emailViewKey" TEXT;


-- Orders paid before confirmation emails existed are treated as sent, so the retry sweep
-- doesn't email them now.
UPDATE "Order" SET "confirmationSentAt" = "updatedAt" WHERE "status" = 'PAID';
