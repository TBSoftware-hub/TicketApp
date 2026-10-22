-- AlterTable
ALTER TABLE "GuardianSignatureRequest" ADD COLUMN     "emailDeliveredAt" TIMESTAMP(3),
ADD COLUMN     "remindersDelivered" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "textDeliveredAt" TIMESTAMP(3);


-- Until now the send times were the only record of delivery.
UPDATE "GuardianSignatureRequest" SET "emailDeliveredAt" = "emailSentAt", "textDeliveredAt" = "textSentAt";
