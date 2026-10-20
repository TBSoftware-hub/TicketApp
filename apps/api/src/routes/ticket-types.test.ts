import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("ticket types", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  async function ownerWithEvent() {
    const owner = await t.signIn();
    const org = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High School", slug: uniqueSlug("ths"), type: "SCHOOL" },
    });
    const orgId = org.json<{ organization: { id: string } }>().organization.id;
    const event = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: {
        name: "Homecoming Dance",
        slug: uniqueSlug("homecoming"),
        startsAt: "2026-11-15T00:00:00.000Z",
        endsAt: "2026-11-15T03:00:00.000Z",
      },
    });
    const eventId = event.json<{ event: { id: string } }>().event.id;
    return { owner, orgId, eventId, base: `/orgs/${orgId}/events/${eventId}/ticket-types` };
  }

  async function create(
    headers: Record<string, string>,
    base: string,
    payload: Record<string, unknown> = {},
  ) {
    return t.app.inject({
      method: "POST",
      url: base,
      headers,
      payload: { name: "General", priceCents: 1500, maxPerOrder: 6, ...payload },
    });
  }

  async function sellOne(
    eventId: string,
    ticketTypeId: string,
    status: "VALID" | "VOID" = "VALID",
  ) {
    const order = await t.prisma.order.create({
      data: {
        eventId,
        buyerName: "Pat Parent",
        buyerEmail: "pat@example.com",
        status: "PAID",
        subtotalCents: 1500,
        totalCents: 1500,
      },
    });
    const attendee = await t.prisma.attendee.create({
      data: { firstName: "Sam", lastName: "Student" },
    });
    await t.prisma.ticket.create({
      data: {
        code: randomUUID(),
        orderId: order.id,
        eventId,
        ticketTypeId,
        attendeeId: attendee.id,
        status,
      },
    });
  }

  it("creates ticket types and lists them in order with sold counts", async () => {
    const { owner, base } = await ownerWithEvent();
    const window = {
      salesStartAt: "2026-10-25T12:00:00.000Z",
      salesEndAt: "2026-11-14T23:00:00.000Z",
    };
    const general = await create(owner.headers, base, { quantity: 300, ...window });
    expect(general.statusCode).toBe(201);
    expect(general.json().ticketType).toMatchObject({
      name: "General",
      priceCents: 1500,
      quantity: 300,
      maxPerOrder: 6,
      ...window,
      sold: 0,
      hasTickets: false,
    });
    await create(owner.headers, base, { name: "Staff (free)", priceCents: 0 });

    const list = await t.app.inject({ method: "GET", url: base, headers: owner.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().ticketTypes.map((x: { name: string }) => x.name)).toEqual([
      "General",
      "Staff (free)",
    ]);
  });

  it("rejects a bad price or sale window", async () => {
    const { owner, base } = await ownerWithEvent();
    expect((await create(owner.headers, base, { priceCents: 12.5 })).statusCode).toBe(400);
    const backwards = await create(owner.headers, base, {
      salesStartAt: "2026-11-01T00:00:00.000Z",
      salesEndAt: "2026-10-01T00:00:00.000Z",
    });
    expect(backwards.statusCode).toBe(400);
  });

  it("edits a ticket type, checking one end of the sale window against the stored other end", async () => {
    const { owner, base } = await ownerWithEvent();
    const { id } = (
      await create(owner.headers, base, { salesStartAt: "2026-11-01T00:00:00.000Z" })
    ).json().ticketType;

    const ok = await t.app.inject({
      method: "PATCH",
      url: `${base}/${id}`,
      headers: owner.headers,
      payload: { priceCents: 2000, salesEndAt: "2026-11-10T00:00:00.000Z" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ticketType).toMatchObject({
      priceCents: 2000,
      salesEndAt: "2026-11-10T00:00:00.000Z",
    });

    const backwards = await t.app.inject({
      method: "PATCH",
      url: `${base}/${id}`,
      headers: owner.headers,
      payload: { salesStartAt: "2026-11-12T00:00:00.000Z" },
    });
    expect(backwards.statusCode).toBe(400);

    const cleared = await t.app.inject({
      method: "PATCH",
      url: `${base}/${id}`,
      headers: owner.headers,
      payload: { salesStartAt: null, salesEndAt: null, quantity: null },
    });
    expect(cleared.json().ticketType).toMatchObject({
      salesStartAt: null,
      salesEndAt: null,
      quantity: null,
    });
  });

  it("won't drop the quantity below what's sold or delete a type with sales", async () => {
    const { owner, eventId, base } = await ownerWithEvent();
    const { id } = (await create(owner.headers, base, { quantity: 10 })).json().ticketType;
    await sellOne(eventId, id);
    await sellOne(eventId, id);

    const tooFew = await t.app.inject({
      method: "PATCH",
      url: `${base}/${id}`,
      headers: owner.headers,
      payload: { quantity: 1 },
    });
    expect(tooFew.statusCode).toBe(409);
    expect(tooFew.json().error).toMatch(/2 of these tickets are already sold/);

    const exact = await t.app.inject({
      method: "PATCH",
      url: `${base}/${id}`,
      headers: owner.headers,
      payload: { quantity: 2 },
    });
    expect(exact.json().ticketType).toMatchObject({ quantity: 2, sold: 2 });

    const del = await t.app.inject({
      method: "DELETE",
      url: `${base}/${id}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(409);
  });

  it("counts only valid tickets as sold but won't delete a type with voided tickets", async () => {
    const { owner, eventId, base } = await ownerWithEvent();
    const { id } = (await create(owner.headers, base)).json().ticketType;
    await sellOne(eventId, id, "VOID");

    const list = await t.app.inject({ method: "GET", url: base, headers: owner.headers });
    expect(list.json().ticketTypes[0]).toMatchObject({ sold: 0, hasTickets: true });
    const del = await t.app.inject({
      method: "DELETE",
      url: `${base}/${id}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(409);
  });

  it("deletes an unsold ticket type", async () => {
    const { owner, base } = await ownerWithEvent();
    const { id } = (await create(owner.headers, base)).json().ticketType;
    const del = await t.app.inject({
      method: "DELETE",
      url: `${base}/${id}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(204);
    const again = await t.app.inject({
      method: "DELETE",
      url: `${base}/${id}`,
      headers: owner.headers,
    });
    expect(again.statusCode).toBe(404);
  });

  it("keeps ticket types inside their own organization and event", async () => {
    const a = await ownerWithEvent();
    const b = await ownerWithEvent();
    const { id } = (await create(a.owner.headers, a.base)).json().ticketType;

    // B's owner can't reach A's event at all.
    const list = await t.app.inject({ method: "GET", url: a.base, headers: b.owner.headers });
    expect(list.statusCode).toBe(404);
    // Nor A's ticket type through B's own event.
    for (const method of ["PATCH", "DELETE"] as const) {
      const res = await t.app.inject({
        method,
        url: `${b.base}/${id}`,
        headers: b.owner.headers,
        payload: method === "PATCH" ? { priceCents: 1 } : undefined,
      });
      expect(res.statusCode).toBe(404);
    }
    // Nor create one under A's event through B's org.
    const res = await create(b.owner.headers, `/orgs/${b.orgId}/events/${a.eventId}/ticket-types`);
    expect(res.statusCode).toBe(404);
  });

  it("lets viewers list but not change ticket types", async () => {
    const { owner, base, orgId } = await ownerWithEvent();
    const email = `v-${randomUUID()}@example.com`;
    await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/invitations`,
      headers: owner.headers,
      payload: { email, role: "VIEWER" },
    });
    const token = new URL(
      t.sent.findLast((m) => m.to === email)!.text.match(/https:\S+/)![0],
    ).searchParams.get("token");
    const accepted = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token },
    });
    const viewer = { authorization: `Bearer ${accepted.json().sessionToken}` };

    expect((await t.app.inject({ method: "GET", url: base, headers: viewer })).statusCode).toBe(
      200,
    );
    expect((await create(viewer, base)).statusCode).toBe(403);
  });
});
