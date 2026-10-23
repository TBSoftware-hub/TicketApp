import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("door scanner", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  /** A published event with a Guest ticket type, and a way to comp tickets and scan codes. */
  async function party() {
    const owner = await t.signIn();
    const orgId = (
      await t.app.inject({
        method: "POST",
        url: "/orgs",
        headers: owner.headers,
        payload: { name: "Test High School", slug: uniqueSlug("ths"), type: "SCHOOL" },
      })
    ).json().organization.id as string;
    const call = (method: "GET" | "POST", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: owner.headers, payload });
    const newEvent = async (name: string) => {
      const startsAt = new Date(Date.now() + 60 * 60_000);
      const eventId = (
        await call("POST", `/orgs/${orgId}/events`, {
          name,
          slug: uniqueSlug("prom"),
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 4 * 60 * 60_000).toISOString(),
        })
      ).json().event.id as string;
      const base = `/orgs/${orgId}/events/${eventId}`;
      const guest = (
        await call("POST", `${base}/ticket-types`, { name: "Guest", priceCents: 0, maxPerOrder: 4 })
      ).json().ticketType.id as string;
      await call("POST", `${base}/status`, { status: "PUBLISHED" });
      return { eventId, base, guest };
    };
    const prom = await newEvent("Prom");

    /** Comps a ticket and returns it with the code its QR carries. */
    const comp = async (firstName: string, event = prom) => {
      const res = await call("POST", `${event.base}/comps`, {
        ticketTypeId: event.guest,
        firstName,
        lastName: "Lee",
        email: `${firstName.toLowerCase()}-${randomUUID()}@example.com`,
      });
      expect(res.statusCode).toBe(201);
      const { id: orderId, tickets } = res.json().comp as { id: string; tickets: { id: string }[] };
      const { code } = await t.prisma.ticket.findUniqueOrThrow({ where: { id: tickets[0]!.id } });
      return { orderId, ticketId: tickets[0]!.id, code };
    };
    const scan = (code: string, headers = owner.headers, base = prom.base) =>
      t.app.inject({ method: "POST", url: `${base}/scans`, headers, payload: { code } });

    return { owner, orgId, call, newEvent, prom, comp, scan };
  }

  it("lets a valid ticket in once, then says when it was used", async () => {
    const p = await party();
    const { ticketId, code } = await p.comp("Ann");

    const first = await p.scan(code);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      outcome: "admitted",
      ticket: { attendeeName: "Ann Lee", ticketTypeName: "Guest" },
    });
    const ticket = await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.isInside).toBe(true);

    const again = await p.scan(code);
    const admitted = await t.prisma.scanEvent.findFirstOrThrow({
      where: { ticketId, outcome: "ADMITTED" },
    });
    expect(again.json()).toEqual({
      outcome: "already_inside",
      ticket: { attendeeName: "Ann Lee", ticketTypeName: "Guest" },
      admittedAt: admitted.scannedAt.toISOString(),
    });

    // Both scans are on record, against the staff member who made them.
    const scans = await t.prisma.scanEvent.findMany({
      where: { ticketId },
      orderBy: { createdAt: "asc" },
    });
    expect(scans).toMatchObject([
      { direction: "IN", outcome: "ADMITTED", staffUserId: p.owner.userId },
      { direction: "IN", outcome: "ALREADY_INSIDE", staffUserId: p.owner.userId },
    ]);
  });

  it("shows the attendee in the list as inside after a scan", async () => {
    const p = await party();
    const { code } = await p.comp("Bo");
    await p.scan(code);
    const list = (await p.call("GET", `${p.prom.base}/attendees?checkIn=inside`)).json();
    expect(list.attendees).toMatchObject([{ firstName: "Bo", checkIn: "inside" }]);
  });

  it("lets only one of two devices scanning the same ticket at once let them in", async () => {
    const p = await party();
    const { code } = await p.comp("Cy");
    const results = await Promise.all([p.scan(code), p.scan(code), p.scan(code)]);
    const outcomes = results.map((r) => r.json().outcome as string).sort();
    expect(outcomes).toEqual(["admitted", "already_inside", "already_inside"]);
  });

  it("trims whitespace a scanner picks up around the code", async () => {
    const p = await party();
    const { code } = await p.comp("Di");
    expect((await p.scan(`  ${code}\n`)).json().outcome).toBe("admitted");
  });

  it("turns away a code that isn't a ticket, and records the scan", async () => {
    const p = await party();
    const res = await p.scan("https://example.com/not-a-ticket");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "invalid_ticket", reason: "unknown" });
    const scans = await t.prisma.scanEvent.findMany({ where: { eventId: p.prom.eventId } });
    expect(scans).toMatchObject([{ ticketId: null, outcome: "INVALID_TICKET" }]);
  });

  it("turns away a ticket for another event without letting it in there", async () => {
    const p = await party();
    const formal = await p.newEvent("Formal");
    const { ticketId, code } = await p.comp("Ed", formal);
    expect((await p.scan(code)).json()).toEqual({
      outcome: "invalid_ticket",
      reason: "other_event",
    });
    const ticket = await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.isInside).toBe(false);
    // The scan stays on this event's record without pointing at the other event's ticket.
    expect(await t.prisma.scanEvent.count({ where: { ticketId } })).toBe(0);
  });

  it("turns away a cancelled ticket", async () => {
    const p = await party();
    const { orderId, ticketId, code } = await p.comp("Flo");
    const voided = await p.call("POST", `${p.prom.base}/comps/${orderId}/void`);
    expect(voided.statusCode).toBe(200);
    expect((await p.scan(code)).json()).toEqual({ outcome: "invalid_ticket", reason: "cancelled" });
    const scans = await t.prisma.scanEvent.findMany({ where: { ticketId } });
    expect(scans).toMatchObject([{ outcome: "INVALID_TICKET" }]);
  });

  it("turns away the old code of a ticket given to someone else, and lets the new one in", async () => {
    const p = await party();
    const { ticketId, code } = await p.comp("Gil");
    const moved = await p.call("POST", `${p.prom.base}/tickets/${ticketId}/transfer`, {
      firstName: "Hal",
      lastName: "Lee",
    });
    expect(moved.statusCode).toBe(201);
    expect((await p.scan(code)).json()).toEqual({
      outcome: "invalid_ticket",
      reason: "transferred",
    });
    const replacement = await t.prisma.ticket.findUniqueOrThrow({
      where: { transferredFromId: ticketId },
    });
    expect((await p.scan(replacement.code)).json()).toMatchObject({
      outcome: "admitted",
      ticket: { attendeeName: "Hal Lee" },
    });
  });

  it("waits for a transfer in progress and then turns the old code away", async () => {
    const p = await party();
    const { orderId, ticketId, code } = await p.comp("Nia");
    let scanning: ReturnType<typeof p.scan> | undefined;
    // A transfer locks the order and voids the old ticket without touching the order row; a scan
    // that starts meanwhile has to see the voided ticket once the transfer commits.
    await t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      await tx.ticket.update({ where: { id: ticketId }, data: { status: "VOID" } });
      scanning = p.scan(code);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect((await scanning!).json()).toEqual({ outcome: "invalid_ticket", reason: "cancelled" });
    const ticket = await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.isInside).toBe(false);
  });

  it("turns away a ticket whose checkout wasn't paid for", async () => {
    const p = await party();
    const { orderId, code } = await p.comp("Ivy");
    await t.prisma.order.update({ where: { id: orderId }, data: { status: "PENDING" } });
    await t.prisma.ticket.updateMany({ where: { orderId }, data: { status: "HELD" } });
    expect((await p.scan(code)).json()).toEqual({ outcome: "invalid_ticket", reason: "unpaid" });
  });

  it("stops a ticket being given away once its holder is inside", async () => {
    const p = await party();
    const { ticketId, code } = await p.comp("Jo");
    await p.scan(code);
    const moved = await p.call("POST", `${p.prom.base}/tickets/${ticketId}/transfer`, {
      firstName: "Kim",
      lastName: "Lee",
    });
    expect(moved.statusCode).toBe(409);
  });

  it("lets door staff scan, and keeps out anyone who isn't on the team", async () => {
    const p = await party();
    const { code } = await p.comp("Lu");
    const door = await t.signIn();
    await t.prisma.membership.create({
      data: { userId: door.userId, organizationId: p.orgId, role: "DOOR_STAFF" },
    });
    expect((await p.scan(code, door.headers)).json().outcome).toBe("admitted");

    const stranger = await t.signIn();
    expect((await p.scan(code, stranger.headers)).statusCode).toBe(404);
    const signedOut = await t.app.inject({
      method: "POST",
      url: `${p.prom.base}/scans`,
      payload: { code },
    });
    expect(signedOut.statusCode).toBe(401);
  });

  it("checks the event belongs to the organization", async () => {
    const p = await party();
    const other = await party();
    const { code } = await other.comp("Mo");
    const res = await p.scan(
      code,
      p.owner.headers,
      `/orgs/${p.orgId}/events/${other.prom.eventId}`,
    );
    expect(res.statusCode).toBe(404);
  });

  it("stops scanning for an event that was cancelled, unpublished or has ended", async () => {
    const p = await party();
    const { code } = await p.comp("Oz");
    const where = { id: p.prom.eventId };
    await t.prisma.event.update({ where, data: { status: "CANCELLED" } });
    expect((await p.scan(code)).json()).toEqual({ error: "This event was cancelled" });
    await t.prisma.event.update({ where, data: { status: "DRAFT" } });
    expect((await p.scan(code)).json()).toEqual({ error: "This event isn't published yet" });
    await t.prisma.event.update({
      where,
      data: {
        status: "PUBLISHED",
        startsAt: new Date(Date.now() - 5 * 60 * 60_000),
        endsAt: new Date(Date.now() - 60_000),
      },
    });
    const ended = await p.scan(code);
    expect(ended.statusCode).toBe(409);
    expect(ended.json()).toEqual({ error: "This event has ended" });
    expect(await t.prisma.scanEvent.count({ where: { eventId: p.prom.eventId } })).toBe(0);
  });

  it("rejects an empty scan", async () => {
    const p = await party();
    expect((await p.scan("   ")).statusCode).toBe(400);
  });
});
