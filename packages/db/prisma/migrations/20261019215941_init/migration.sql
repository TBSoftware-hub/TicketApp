-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('SCHOOL', 'COMMITTEE', 'NONPROFIT');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'DOOR_STAFF', 'VIEWER');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'CASH', 'COMP');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('VALID', 'VOID');

-- CreateEnum
CREATE TYPE "SignerRole" AS ENUM ('ATTENDEE', 'GUARDIAN');

-- CreateEnum
CREATE TYPE "ScanDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "ScanOutcome" AS ENUM ('ADMITTED', 'CHECKED_OUT', 'ALREADY_INSIDE', 'NOT_INSIDE', 'WAIVER_MISSING', 'INVALID_TICKET');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "District" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "District_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "OrganizationType" NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "districtId" UUID,
    "stripeAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "venue" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketType" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "quantity" INTEGER,
    "maxPerOrder" INTEGER NOT NULL DEFAULT 10,
    "salesStartAt" TIMESTAMP(3),
    "salesEndAt" TIMESTAMP(3),
    "studentsOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "buyerName" TEXT NOT NULL,
    "buyerEmail" TEXT NOT NULL,
    "buyerPhone" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'CARD',
    "subtotalCents" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "stripePaymentIntentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "orderId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "ticketTypeId" UUID NOT NULL,
    "attendeeId" UUID NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'VALID',
    "isInside" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendee" (
    "id" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "dateOfBirth" DATE,
    "grade" INTEGER,
    "studentId" TEXT,
    "emergencyContact" TEXT,
    "medicalNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guardian" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "smsOptInAt" TIMESTAMP(3),
    "smsOptOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guardian_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendeeGuardian" (
    "attendeeId" UUID NOT NULL,
    "guardianId" UUID NOT NULL,
    "relationship" TEXT,
    "notify" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AttendeeGuardian_pkey" PRIMARY KEY ("attendeeId","guardianId")
);

-- CreateTable
CREATE TABLE "WaiverTemplate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "requiresGuardianForMinors" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaiverTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventWaiver" (
    "eventId" UUID NOT NULL,
    "waiverTemplateId" UUID NOT NULL,

    CONSTRAINT "EventWaiver_pkey" PRIMARY KEY ("eventId","waiverTemplateId")
);

-- CreateTable
CREATE TABLE "WaiverSignature" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "waiverTemplateId" UUID NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "signerRole" "SignerRole" NOT NULL,
    "signerName" TEXT NOT NULL,
    "guardianId" UUID,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "documentHash" TEXT NOT NULL,
    "pdfStorageKey" TEXT,

    CONSTRAINT "WaiverSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanEvent" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "ticketId" UUID,
    "direction" "ScanDirection" NOT NULL,
    "outcome" "ScanOutcome" NOT NULL,
    "overrideReason" TEXT,
    "staffUserId" UUID,
    "deviceId" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "guardianId" UUID,
    "scanEventId" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "to" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_stripeAccountId_key" ON "Organization"("stripeAccountId");

-- CreateIndex
CREATE INDEX "Organization_districtId_idx" ON "Organization"("districtId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_organizationId_idx" ON "Membership"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_organizationId_key" ON "Membership"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "Event_organizationId_startsAt_idx" ON "Event"("organizationId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Event_organizationId_slug_key" ON "Event"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "TicketType_eventId_idx" ON "TicketType"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_stripePaymentIntentId_key" ON "Order"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "Order_eventId_status_idx" ON "Order"("eventId", "status");

-- CreateIndex
CREATE INDEX "Order_buyerEmail_idx" ON "Order"("buyerEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_code_key" ON "Ticket"("code");

-- CreateIndex
CREATE INDEX "Ticket_eventId_isInside_idx" ON "Ticket"("eventId", "isInside");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_eventId_attendeeId_key" ON "Ticket"("eventId", "attendeeId");

-- CreateIndex
CREATE INDEX "AttendeeGuardian_guardianId_idx" ON "AttendeeGuardian"("guardianId");

-- CreateIndex
CREATE INDEX "WaiverTemplate_organizationId_idx" ON "WaiverTemplate"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "WaiverSignature_ticketId_waiverTemplateId_signerRole_key" ON "WaiverSignature"("ticketId", "waiverTemplateId", "signerRole");

-- CreateIndex
CREATE INDEX "ScanEvent_eventId_scannedAt_idx" ON "ScanEvent"("eventId", "scannedAt");

-- CreateIndex
CREATE INDEX "ScanEvent_ticketId_idx" ON "ScanEvent"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_providerMessageId_key" ON "Notification"("providerMessageId");

-- CreateIndex
CREATE INDEX "Notification_status_idx" ON "Notification"("status");

-- CreateIndex
CREATE INDEX "Notification_scanEventId_idx" ON "Notification"("scanEventId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_attendeeId_fkey" FOREIGN KEY ("attendeeId") REFERENCES "Attendee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendeeGuardian" ADD CONSTRAINT "AttendeeGuardian_attendeeId_fkey" FOREIGN KEY ("attendeeId") REFERENCES "Attendee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendeeGuardian" ADD CONSTRAINT "AttendeeGuardian_guardianId_fkey" FOREIGN KEY ("guardianId") REFERENCES "Guardian"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverTemplate" ADD CONSTRAINT "WaiverTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventWaiver" ADD CONSTRAINT "EventWaiver_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventWaiver" ADD CONSTRAINT "EventWaiver_waiverTemplateId_fkey" FOREIGN KEY ("waiverTemplateId") REFERENCES "WaiverTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverSignature" ADD CONSTRAINT "WaiverSignature_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverSignature" ADD CONSTRAINT "WaiverSignature_waiverTemplateId_fkey" FOREIGN KEY ("waiverTemplateId") REFERENCES "WaiverTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverSignature" ADD CONSTRAINT "WaiverSignature_guardianId_fkey" FOREIGN KEY ("guardianId") REFERENCES "Guardian"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_guardianId_fkey" FOREIGN KEY ("guardianId") REFERENCES "Guardian"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_scanEventId_fkey" FOREIGN KEY ("scanEventId") REFERENCES "ScanEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
