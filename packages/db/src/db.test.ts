import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./index";
import { DEMO_ORG_SLUG, seed } from "./seed-data";

// Runs against a real Postgres with migrations applied (CI provides one; locally see README).
const prisma = createPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe("database schema", () => {
  it("seeds idempotently", async () => {
    await seed(prisma);
    await seed(prisma);

    const org = await prisma.organization.findUniqueOrThrow({
      where: { slug: DEMO_ORG_SLUG },
      include: { events: { include: { ticketTypes: { include: { waivers: true } } } } },
    });
    expect(org.events).toHaveLength(1);
    expect(org.events[0]?.ticketTypes).toHaveLength(1);
    expect(org.events[0]?.ticketTypes[0]?.waivers).toHaveLength(1);
    expect(await prisma.ticket.count({ where: { code: "DEMO-TICKET-0001" } })).toBe(1);
  });

  it("allows only one ticket per attendee per event", async () => {
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { code: "DEMO-TICKET-0001" } });
    await expect(
      prisma.ticket.create({
        data: {
          code: "DEMO-TICKET-DUPLICATE",
          orderId: ticket.orderId,
          eventId: ticket.eventId,
          ticketTypeId: ticket.ticketTypeId,
          attendeeId: ticket.attendeeId,
        },
      }),
    ).rejects.toThrow();
  });

  it("links guardians to attendees for check-in texts", async () => {
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { code: "DEMO-TICKET-0001" },
      include: { attendee: { include: { guardians: { include: { guardian: true } } } } },
    });
    const guardian = ticket.attendee.guardians[0]?.guardian;
    expect(guardian?.smsOptInAt).toBeInstanceOf(Date);
  });
});
