-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "waiversRequired" BOOLEAN NOT NULL DEFAULT false;


-- Existing tickets: what the type asks for now is the best record of what it asked for then,
-- and any ticket someone signed for clearly needed it.
UPDATE "Ticket" t SET "waiversRequired" = true
WHERE EXISTS (SELECT 1 FROM "TicketTypeWaiver" w WHERE w."ticketTypeId" = t."ticketTypeId")
   OR EXISTS (SELECT 1 FROM "WaiverSignature" s WHERE s."ticketId" = t.id);
