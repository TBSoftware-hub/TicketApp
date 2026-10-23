-- AlterEnum
ALTER TYPE "ScanOutcome" ADD VALUE 'REENTRY_DENIED';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "reentryAllowed" BOOLEAN NOT NULL DEFAULT false;

