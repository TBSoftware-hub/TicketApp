import type { PrismaClient } from "./index";

export const DEMO_ORG_SLUG = "lincoln-high-after-prom";

/**
 * Demo data for local development: one school with an after-prom, a waiver and one paid ticket.
 * Safe to run repeatedly; every row is upserted on a natural key.
 */
export async function seed(prisma: PrismaClient) {
  const district = await prisma.district.upsert({
    where: { id: "0199f6b0-0000-7000-8000-000000000001" },
    update: {},
    create: { id: "0199f6b0-0000-7000-8000-000000000001", name: "Lincoln Unified School District" },
  });

  const org = await prisma.organization.upsert({
    where: { slug: DEMO_ORG_SLUG },
    update: {},
    create: {
      name: "Lincoln High After-Prom Committee",
      slug: DEMO_ORG_SLUG,
      type: "COMMITTEE",
      districtId: district.id,
    },
  });

  const owner = await prisma.user.upsert({
    where: { email: "chair@example.com" },
    update: {},
    create: { email: "chair@example.com", name: "Committee Chair" },
  });

  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: owner.id, organizationId: org.id } },
    update: {},
    create: { userId: owner.id, organizationId: org.id, role: "OWNER" },
  });

  const event = await prisma.event.upsert({
    where: { organizationId_slug: { organizationId: org.id, slug: "after-prom-2027" } },
    update: {},
    create: {
      organizationId: org.id,
      name: "After-Prom 2027",
      slug: "after-prom-2027",
      venue: "Lincoln High Gym",
      startsAt: new Date("2027-04-24T03:30:00Z"),
      endsAt: new Date("2027-04-24T09:00:00Z"),
      capacity: 600,
      status: "PUBLISHED",
    },
  });

  const ticketType =
    (await prisma.ticketType.findFirst({ where: { eventId: event.id, name: "Student" } })) ??
    (await prisma.ticketType.create({
      data: { eventId: event.id, name: "Student", priceCents: 2500, studentsOnly: true },
    }));

  const waiver =
    (await prisma.waiverTemplate.findFirst({
      where: { organizationId: org.id, title: "After-Prom Participation Waiver" },
    })) ??
    (await prisma.waiverTemplate.create({
      data: {
        organizationId: org.id,
        title: "After-Prom Participation Waiver",
        body: "I agree to follow event rules, including inflatable and activity safety instructions.",
      },
    }));

  await prisma.eventWaiver.upsert({
    where: { eventId_waiverTemplateId: { eventId: event.id, waiverTemplateId: waiver.id } },
    update: {},
    create: { eventId: event.id, waiverTemplateId: waiver.id },
  });

  const existingTicket = await prisma.ticket.findUnique({ where: { code: "DEMO-TICKET-0001" } });
  if (!existingTicket) {
    const guardian = await prisma.guardian.create({
      data: {
        name: "Pat Rivera",
        phone: "+15555550123",
        email: "pat.rivera@example.com",
        smsOptInAt: new Date(),
      },
    });
    const attendee = await prisma.attendee.create({
      data: {
        firstName: "Sam",
        lastName: "Rivera",
        grade: 12,
        guardians: { create: { guardianId: guardian.id, relationship: "Parent" } },
      },
    });
    await prisma.order.create({
      data: {
        eventId: event.id,
        buyerName: "Pat Rivera",
        buyerEmail: "pat.rivera@example.com",
        status: "PAID",
        subtotalCents: ticketType.priceCents,
        totalCents: ticketType.priceCents,
        tickets: {
          create: {
            code: "DEMO-TICKET-0001",
            eventId: event.id,
            ticketTypeId: ticketType.id,
            attendeeId: attendee.id,
          },
        },
      },
    });
  }

  return { org, event };
}
