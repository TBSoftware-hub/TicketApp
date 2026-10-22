-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "transferredFromId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_transferredFromId_key" ON "Ticket"("transferredFromId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_transferredFromId_fkey" FOREIGN KEY ("transferredFromId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

