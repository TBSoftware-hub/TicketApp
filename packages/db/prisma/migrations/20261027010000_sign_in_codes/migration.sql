-- AlterTable
ALTER TABLE "MagicLinkToken" ADD COLUMN     "codeHash" TEXT,
ADD COLUMN     "failedAttempts" INTEGER NOT NULL DEFAULT 0;

