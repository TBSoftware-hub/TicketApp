-- CreateIndex
CREATE INDEX "Invitation_email_createdAt_idx" ON "Invitation"("email", "createdAt");

-- CreateIndex
CREATE INDEX "Invitation_invitedById_createdAt_idx" ON "Invitation"("invitedById", "createdAt");
