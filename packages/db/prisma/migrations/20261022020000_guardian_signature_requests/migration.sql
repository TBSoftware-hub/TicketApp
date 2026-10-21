-- CreateTable
CREATE TABLE "GuardianSignatureRequest" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "guardianId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "pendingMessages" JSONB,
    "emailSentAt" TIMESTAMP(3),
    "textSentAt" TIMESTAMP(3),
    "sendClaimedAt" TIMESTAMP(3),
    "sendFirstTriedAt" TIMESTAMP(3),
    "sendAttempts" INTEGER NOT NULL DEFAULT 0,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardianSignatureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuardianSignatureRequest_ticketId_key" ON "GuardianSignatureRequest"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "GuardianSignatureRequest_tokenHash_key" ON "GuardianSignatureRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "GuardianSignatureRequest_guardianId_idx" ON "GuardianSignatureRequest"("guardianId");

-- AddForeignKey
ALTER TABLE "GuardianSignatureRequest" ADD CONSTRAINT "GuardianSignatureRequest_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianSignatureRequest" ADD CONSTRAINT "GuardianSignatureRequest_guardianId_fkey" FOREIGN KEY ("guardianId") REFERENCES "Guardian"("id") ON DELETE CASCADE ON UPDATE CASCADE;

