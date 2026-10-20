import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("promo codes and comp tickets", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  async function eventWithTickets(capacity: number | null = 300) {
    const owner = await t.signIn();
    const org = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High School", slug: uniqueSlug("ths"), type: "SCHOOL" },
    });
    const orgId = org.json().organization.id as string;
    const event = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: {
        name: "After Prom",
        slug: uniqueSlug("prom"),
        startsAt: "2099-05-01T03:00:00.000Z",
        endsAt: "2099-05-01T09:00:00.000Z",
        capacity,
      },
    });
    const eventId = event.json().event.id as string;
    const base = `/orgs/${orgId}/events/${eventId}`;
    const addType = async (payload: Record<string, unknown> = {}) =>
      (
        await t.app.inject({
          method: "POST",
          url: `${base}/ticket-types`,
          headers: owner.headers,
          payload: { name: "Student", priceCents: 3000, maxPerOrder: 4, ...payload },
        })
      ).json().ticketType.id as string;
    const call = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: object) =>
      t.app.inject({ method, url: `${base}${path}`, headers: owner.headers, payload });
    return { owner, orgId, eventId, base, addType, call };
  }

  describe("promo codes", () => {
    it("creates codes, upper-cased, optionally limited to some ticket types", async () => {
      const { addType, call } = await eventWithTickets();
      const student = await addType();
      await addType({ name: "Guest" });
      const res = await call("POST", "/promo-codes", {
        code: "early-bird",
        discountType: "PERCENT",
        discountValue: 20,
        maxUses: 50,
        ticketTypeIds: [student],
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().promoCode).toMatchObject({
        code: "EARLY-BIRD",
        discountType: "PERCENT",
        discountValue: 20,
        maxUses: 50,
        active: true,
        ticketTypeIds: [student],
        uses: 0,
      });

      const dupe = await call("POST", "/promo-codes", {
        code: "Early-Bird",
        discountType: "AMOUNT",
        discountValue: 500,
      });
      expect(dupe.statusCode).toBe(409);
      const list = await call("GET", "/promo-codes");
      expect(list.json().promoCodes).toHaveLength(1);
    });

    it("won't limit a code to another event's ticket type", async () => {
      const a = await eventWithTickets();
      const b = await eventWithTickets();
      const foreign = await b.addType();
      const res = await a.call("POST", "/promo-codes", {
        code: "SNEAKY",
        discountType: "PERCENT",
        discountValue: 10,
        ticketTypeIds: [foreign],
      });
      expect(res.statusCode).toBe(400);
    });

    it("turns codes off, and deletes only codes no order has used", async () => {
      const { eventId, call } = await eventWithTickets();
      const unused = (
        await call("POST", "/promo-codes", {
          code: "UNUSED",
          discountType: "PERCENT",
          discountValue: 5,
        })
      ).json().promoCode.id;
      const used = (
        await call("POST", "/promo-codes", {
          code: "USED",
          discountType: "AMOUNT",
          discountValue: 500,
        })
      ).json().promoCode.id;
      await t.prisma.order.create({
        data: {
          eventId,
          buyerName: "Pat Parent",
          buyerEmail: "pat@example.com",
          status: "PAID",
          subtotalCents: 3000,
          discountCents: 500,
          totalCents: 2500,
          promoCodeId: used,
        },
      });

      const off = await call("PATCH", `/promo-codes/${used}`, { active: false });
      expect(off.json().promoCode).toMatchObject({ active: false, uses: 1 });
      expect((await call("DELETE", `/promo-codes/${used}`)).statusCode).toBe(409);
      expect((await call("DELETE", `/promo-codes/${unused}`)).statusCode).toBe(204);
      expect((await call("DELETE", `/promo-codes/${unused}`)).statusCode).toBe(404);
    });

    it("keeps codes inside their own organization", async () => {
      const a = await eventWithTickets();
      const b = await eventWithTickets();
      const id = (
        await a.call("POST", "/promo-codes", {
          code: "MINE",
          discountType: "PERCENT",
          discountValue: 5,
        })
      ).json().promoCode.id;
      const res = await t.app.inject({
        method: "PATCH",
        url: `${b.base}/promo-codes/${id}`,
        headers: b.owner.headers,
        payload: { active: false },
      });
      expect(res.statusCode).toBe(404);
      const list = await t.app.inject({
        method: "GET",
        url: `${a.base}/promo-codes`,
        headers: b.owner.headers,
      });
      expect(list.statusCode).toBe(404);
    });
  });

  describe("comp tickets", () => {
    const chaperone = (ticketTypeId: string, n = 1) => ({
      ticketTypeId,
      firstName: "Casey",
      lastName: `Chaperone${n}`,
      email: `Casey${n}@Example.com`,
      note: "Parent volunteer",
    });

    it("issues a free ticket to one person and lists it", async () => {
      const { addType, call } = await eventWithTickets();
      const type = await addType({ studentsOnly: true });
      const res = await call("POST", "/comps", chaperone(type));
      expect(res.statusCode).toBe(201);
      expect(res.json().comp).toMatchObject({
        buyerName: "Casey Chaperone1",
        buyerEmail: "casey1@example.com",
        note: "Parent volunteer",
        status: "PAID",
        compedBy: { name: "Test Staff" },
        tickets: [
          {
            status: "VALID",
            ticketType: { id: type, name: "Student" },
            attendee: { firstName: "Casey", lastName: "Chaperone1" },
          },
        ],
      });
      const order = await t.prisma.order.findUniqueOrThrow({
        where: { id: res.json().comp.id },
        include: { tickets: true },
      });
      expect(order).toMatchObject({ paymentMethod: "COMP", totalCents: 0 });
      expect(order.tickets[0]!.code).toMatch(/^[\w-]{22}$/);

      const list = await call("GET", "/comps");
      expect(list.json().comps).toHaveLength(1);
    });

    it("counts comps against the ticket type's quantity and the event's capacity", async () => {
      const limited = await eventWithTickets();
      const type = await limited.addType({ quantity: 1 });
      expect((await limited.call("POST", "/comps", chaperone(type, 1))).statusCode).toBe(201);
      const soldOut = await limited.call("POST", "/comps", chaperone(type, 2));
      expect(soldOut.statusCode).toBe(409);
      expect(soldOut.json().error).toMatch(/sold out/);

      const full = await eventWithTickets(1);
      const open = await full.addType();
      expect((await full.call("POST", "/comps", chaperone(open, 1))).statusCode).toBe(201);
      const atCapacity = await full.call("POST", "/comps", chaperone(open, 2));
      expect(atCapacity.statusCode).toBe(409);
      expect(atCapacity.json().error).toMatch(/capacity/);
    });

    it("never over-issues when comps for different types race for the last seats", async () => {
      const { addType, call } = await eventWithTickets(3);
      const types = [await addType(), await addType({ name: "Guest" })];
      const results = await Promise.all(
        [1, 2, 3, 4, 5, 6].map((n) => call("POST", "/comps", chaperone(types[n % 2]!, n))),
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
    });

    it("voids a comp, which frees its seat", async () => {
      const { addType, call } = await eventWithTickets(1);
      const type = await addType();
      const id = (await call("POST", "/comps", chaperone(type, 1))).json().comp.id;
      const voided = await call("POST", `/comps/${id}/void`);
      expect(voided.json().comp).toMatchObject({
        status: "CANCELLED",
        tickets: [{ status: "VOID" }],
      });
      expect((await call("POST", "/comps", chaperone(type, 2))).statusCode).toBe(201);
    });

    it("won't comp a ticket type from another event or for a cancelled event", async () => {
      const a = await eventWithTickets();
      const b = await eventWithTickets();
      const foreign = await b.addType();
      expect((await a.call("POST", "/comps", chaperone(foreign))).statusCode).toBe(400);

      const type = await a.addType();
      await a.call("POST", "/status", { status: "PUBLISHED" });
      await a.call("POST", "/status", { status: "CANCELLED" });
      expect((await a.call("POST", "/comps", chaperone(type))).statusCode).toBe(409);
    });
  });
});
