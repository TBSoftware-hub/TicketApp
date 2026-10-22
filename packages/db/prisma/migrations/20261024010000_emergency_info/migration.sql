-- AlterTable
ALTER TABLE "Attendee" ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactPhone" TEXT;

-- Nothing wrote the old free-text column, but keep anything that's there.
UPDATE "Attendee" SET "emergencyContactName" = "emergencyContact" WHERE "emergencyContact" IS NOT NULL;

ALTER TABLE "Attendee" DROP COLUMN "emergencyContact";

-- AlterTable
ALTER TABLE "TicketType" ADD COLUMN     "askEmergencyInfo" BOOLEAN NOT NULL DEFAULT false;
