-- AlterTable
ALTER TABLE "GuardianSignatureRequest" ADD COLUMN     "remindersSent" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "GuardianSignatureLink" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuardianSignatureLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuardianSignatureLink_tokenHash_key" ON "GuardianSignatureLink"("tokenHash");

-- CreateIndex
CREATE INDEX "GuardianSignatureLink_requestId_idx" ON "GuardianSignatureLink"("requestId");

-- AddForeignKey
ALTER TABLE "GuardianSignatureLink" ADD CONSTRAINT "GuardianSignatureLink_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "GuardianSignatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

