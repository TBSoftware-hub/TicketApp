-- Waivers move from events to ticket types, so each kind of ticket can ask for its own.

-- AlterTable
ALTER TABLE "WaiverSignature" ADD COLUMN     "answers" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "TicketTypeWaiver" (
    "ticketTypeId" UUID NOT NULL,
    "waiverTemplateId" UUID NOT NULL,

    CONSTRAINT "TicketTypeWaiver_pkey" PRIMARY KEY ("ticketTypeId","waiverTemplateId")
);

-- CreateIndex
CREATE INDEX "TicketTypeWaiver_waiverTemplateId_idx" ON "TicketTypeWaiver"("waiverTemplateId");

-- AddForeignKey
ALTER TABLE "TicketTypeWaiver" ADD CONSTRAINT "TicketTypeWaiver_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTypeWaiver" ADD CONSTRAINT "TicketTypeWaiver_waiverTemplateId_fkey" FOREIGN KEY ("waiverTemplateId") REFERENCES "WaiverTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A waiver on an event now goes on every ticket type the event has.
INSERT INTO "TicketTypeWaiver" ("ticketTypeId", "waiverTemplateId")
SELECT t."id", ew."waiverTemplateId"
FROM "EventWaiver" ew
JOIN "TicketType" t ON t."eventId" = ew."eventId";

-- DropForeignKey
ALTER TABLE "EventWaiver" DROP CONSTRAINT "EventWaiver_eventId_fkey";

-- DropForeignKey
ALTER TABLE "EventWaiver" DROP CONSTRAINT "EventWaiver_waiverTemplateId_fkey";

-- DropTable
DROP TABLE "EventWaiver";
