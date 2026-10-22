import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("attendee list", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  // A month away, so the minor's date of birth is in the past.
  const startsAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
  const minor = `${startsAt.getUTCFullYear() - 10}-06-01`;

  interface Row {
    ticketId: string;
    firstName: string;
    lastName: string;
    ticketType: { id: string; name: string };
    buyerName: string;
    waiver: string;
    guardianName: string | null;
    checkIn: string;
    checkInAt: string | null;
  }

  /**
   * An event with one attendee in each waiver state: Ann signed, Jo is waiting on a guardian,
   * Cal's comp has no signature, and Gus's guest ticket asks for no waiver.
   */
  async function trip() {
    const owner = await t.signIn();
    const orgSlug = uniqueSlug("ths");
    const org = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High School", slug: orgSlug, type: "SCHOOL" },
    });
    const orgId = org.json().organization.id as string;
    const eventSlug = uniqueSlug("trip");
    const event = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: {
        name: "Museum Trip",
        slug: eventSlug,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 6 * 60 * 60_000).toISOString(),
      },
    });
    const eventId = event.json().event.id as string;
    const base = `/orgs/${orgId}/events/${eventId}`;
    const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: owner.headers, payload });
    const waiver = (
      await call("POST", `/orgs/${orgId}/waivers`, {
        title: "Field Trip Waiver",
        body: "I understand the risks of the trip.",
        requiresGuardianForMinors: true,
        fields: [],
      })
    ).json().waiver as { id: string; version: number };
    const student = (
      await call("POST", `${base}/ticket-types`, {
        name: "Student",
        priceCents: 0,
        maxPerOrder: 4,
        waiverIds: [waiver.id],
      })
    ).json().ticketType.id as string;
    const guest = (
      await call("POST", `${base}/ticket-types`, { name: "Guest", priceCents: 0, maxPerOrder: 4 })
    ).json().ticketType.id as string;
    await call("POST", `${base}/status`, { status: "PUBLISHED" });

    const signed = (signature: string) => [
      { waiverId: waiver.id, version: waiver.version, answers: {}, signature, agreed: true },
    ];
    const res = await t.app.inject({
      method: "POST",
      url: `/public/events/${orgSlug}/${eventSlug}/checkout`,
      payload: {
        buyerName: "Pat Parent",
        buyerEmail: "pat@example.com",
        tickets: [
          {
            ticketTypeId: student,
            firstName: "Ann",
            lastName: "Adams",
            dateOfBirth: "1990-01-01",
            waivers: signed("Ann Adams"),
          },
          {
            ticketTypeId: student,
            firstName: "Jo",
            lastName: "Park",
            dateOfBirth: minor,
            guardian: { name: "Sam Park", email: "sam@example.com" },
            waivers: signed("Jo Park"),
          },
          { ticketTypeId: guest, firstName: "Gus", lastName: "Guest" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const comp = await call("POST", `${base}/comps`, {
      ticketTypeId: student,
      firstName: "Cal",
      lastName: "Comp",
      email: "cal@example.com",
    });
    expect(comp.statusCode).toBe(201);

    const list = async (query = "") => {
      const r = await call("GET", `${base}/attendees${query}`);
      expect(r.statusCode).toBe(200);
      return r.json() as {
        attendees: Row[];
        more: boolean;
        totals: Record<string, number>;
        ticketTypes: { id: string; name: string }[];
      };
    };
    const names = async (query: string) => (await list(query)).attendees.map((a) => a.firstName);
    return { orgId, eventId, base, owner, call, list, names, student, guest };
  }

  it("lists everyone coming, by last name, with where their waivers stand", async () => {
    const s = await trip();
    const { attendees, totals, ticketTypes, more } = await s.list();
    expect(more).toBe(false);
    expect(attendees.map((a) => [a.lastName, a.ticketType.name, a.waiver, a.checkIn])).toEqual([
      ["Adams", "Student", "signed", "not-arrived"],
      ["Comp", "Student", "missing", "not-arrived"],
      ["Guest", "Guest", "none", "not-arrived"],
      ["Park", "Student", "waiting", "not-arrived"],
    ]);
    expect(attendees.find((a) => a.firstName === "Jo")!.guardianName).toBe("Sam Park");
    expect(totals).toEqual({ attendees: 4, signed: 1, waiting: 1, missing: 1, inside: 0, left: 0 });
    expect(ticketTypes.map((tt) => tt.name)).toEqual(["Student", "Guest"]);
  });

  it("searches by attendee, email or buyer, and filters by waiver and ticket type", async () => {
    const s = await trip();
    expect(await s.names("?q=park")).toEqual(["Jo"]);
    expect(await s.names("?q=JO%20PARK")).toEqual(["Jo"]);
    expect(await s.names("?q=cal%40example")).toEqual(["Cal"]);
    expect(await s.names("?q=pat%20parent")).toEqual(["Ann", "Gus", "Jo"]);
    expect(await s.names("?waiver=signed")).toEqual(["Ann"]);
    expect(await s.names("?waiver=waiting")).toEqual(["Jo"]);
    expect(await s.names("?waiver=missing")).toEqual(["Cal"]);
    expect(await s.names("?waiver=none")).toEqual(["Gus"]);
    expect(await s.names(`?ticketTypeId=${s.guest}`)).toEqual(["Gus"]);
    // Blank filters, as an unsubmitted form sends them, mean no filter.
    expect(await s.names("?q=&waiver=&checkIn=&ticketTypeId=")).toHaveLength(4);
    // Filters narrow the list but not the event-wide totals.
    expect((await s.list("?waiver=signed")).totals.attendees).toBe(4);

    const bad = await s.call("GET", `${s.base}/attendees?waiver=maybe`);
    expect(bad.statusCode).toBe(400);
  });

  it("shows who is inside, who has left, and who hasn't arrived", async () => {
    const s = await trip();
    const { attendees } = await s.list();
    const ticket = (name: string) => attendees.find((a) => a.firstName === name)!.ticketId;
    const scan = (
      ticketId: string,
      direction: "IN" | "OUT",
      outcome: "ADMITTED" | "CHECKED_OUT" | "WAIVER_MISSING",
      minutesAgo: number,
      overrideReason?: string,
    ) =>
      t.prisma.scanEvent.create({
        data: {
          eventId: s.eventId,
          ticketId,
          direction,
          outcome,
          overrideReason,
          scannedAt: new Date(Date.now() - minutesAgo * 60_000),
        },
      });
    // Ann came in and is inside; Jo came in and left; Cal was let in with an override; Gus was
    // turned away, which doesn't count as arriving.
    await scan(ticket("Ann"), "IN", "ADMITTED", 30);
    await t.prisma.ticket.update({ where: { id: ticket("Ann") }, data: { isInside: true } });
    await scan(ticket("Jo"), "IN", "ADMITTED", 40);
    await scan(ticket("Jo"), "OUT", "CHECKED_OUT", 10);
    await scan(ticket("Cal"), "IN", "WAIVER_MISSING", 25, "Signed a paper copy at the door");
    await scan(ticket("Gus"), "IN", "WAIVER_MISSING", 20);

    const after = await s.list();
    const row = (name: string) => after.attendees.find((a) => a.firstName === name)!;
    expect(row("Ann").checkIn).toBe("inside");
    expect(row("Jo").checkIn).toBe("left");
    const minutesAgo = (at: string | null) => (Date.now() - new Date(at!).getTime()) / 60_000;
    expect(Math.round(minutesAgo(row("Ann").checkInAt))).toBe(30);
    expect(Math.round(minutesAgo(row("Jo").checkInAt))).toBe(10);
    expect(row("Cal").checkIn).toBe("left");
    expect(row("Gus").checkIn).toBe("not-arrived");
    // Marked out with no check-out scan, so there's no time to show for leaving.
    expect(row("Cal").checkInAt).toBeNull();
    expect(row("Gus").checkInAt).toBeNull();
    expect(after.totals).toMatchObject({ inside: 1, left: 2 });

    expect(await s.names("?checkIn=inside")).toEqual(["Ann"]);
    expect(await s.names("?checkIn=left")).toEqual(["Cal", "Jo"]);
    expect(await s.names("?checkIn=not-arrived")).toEqual(["Gus"]);
    expect(await s.names("?checkIn=left&waiver=waiting")).toEqual(["Jo"]);
  });

  it("doesn't count a check-out scan without a way in as arriving", async () => {
    const s = await trip();
    const gus = (await s.list()).attendees.find((a) => a.firstName === "Gus")!;
    await t.prisma.scanEvent.create({
      data: {
        eventId: s.eventId,
        ticketId: gus.ticketId,
        direction: "OUT",
        outcome: "CHECKED_OUT",
        scannedAt: new Date(),
      },
    });
    const after = (await s.list()).attendees.find((a) => a.firstName === "Gus")!;
    expect(after).toMatchObject({ checkIn: "not-arrived", checkInAt: null });
    expect(await s.names("?checkIn=not-arrived")).toContain("Gus");
  });

  it("judges waivers by what the ticket asked for when it was issued", async () => {
    const s = await trip();
    const waiverId = (await s.call("GET", `/orgs/${s.orgId}/waivers`)).json().waivers[0]
      .id as string;
    // Add the waiver to Guest tickets, and take it off Student tickets.
    expect(
      (await s.call("PATCH", `${s.base}/ticket-types/${s.guest}`, { waiverIds: [waiverId] }))
        .statusCode,
    ).toBe(200);
    expect(
      (await s.call("PATCH", `${s.base}/ticket-types/${s.student}`, { waiverIds: [] })).statusCode,
    ).toBe(200);
    // Gus bought before Guest asked for one; Cal's comp was issued while Student still did.
    const { attendees } = await s.list();
    const status = (name: string) => attendees.find((a) => a.firstName === name)!.waiver;
    expect(status("Gus")).toBe("none");
    expect(status("Cal")).toBe("missing");

    // A Guest ticket issued now does need one.
    await s.call("POST", `${s.base}/comps`, {
      ticketTypeId: s.guest,
      firstName: "Gia",
      lastName: "Guest",
      email: "gia@example.com",
    });
    const sale = await s.call("POST", `${s.base}/door-sales`, {
      saleKey: randomUUID(),
      ticketTypeId: s.guest,
      quantity: 1,
      firstName: "Dee",
      lastName: "Door",
    });
    expect(sale.statusCode).toBe(201);
    expect(await s.names("?waiver=missing")).toEqual(["Cal", "Dee", "Gia"]);
    expect(await s.names("?waiver=none")).toEqual(["Gus"]);
  });

  it("leaves out cancelled tickets", async () => {
    const s = await trip();
    const { orders } = (await s.call("GET", `${s.base}/orders`)).json() as {
      orders: { id: string; buyerName: string }[];
    };
    const comp = orders.find((o) => o.buyerName === "Cal Comp")!;
    const cancel = await s.call("POST", `${s.base}/orders/${comp.id}/cancel`);
    expect(cancel.statusCode).toBe(200);
    expect(await s.names("")).toEqual(["Ann", "Gus", "Jo"]);
    expect((await s.list()).totals.missing).toBe(0);
  });

  it("is for staff who work the door or manage the event", async () => {
    const s = await trip();
    const member = async (role: string) => {
      const email = `m-${randomUUID()}@example.com`;
      await s.call("POST", `/orgs/${s.orgId}/invitations`, { email, role });
      const token = new URL(
        t.sent.findLast((m) => m.to === email)!.text.match(/https:\S+/)![0],
      ).searchParams.get("token");
      const res = await t.app.inject({
        method: "POST",
        url: "/invitations/accept",
        payload: { token },
      });
      return { authorization: `Bearer ${res.json().sessionToken}` };
    };
    const as = (headers: Record<string, string>) =>
      t.app.inject({ method: "GET", url: `${s.base}/attendees`, headers });
    expect((await as(await member("DOOR_STAFF"))).statusCode).toBe(200);
    expect((await as(await member("VIEWER"))).statusCode).toBe(403);
    expect((await as((await t.signIn()).headers)).statusCode).toBe(404);
  });
});
