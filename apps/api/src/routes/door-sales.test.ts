import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderConfirmations } from "../lib/confirmations";
import type { MailMessage } from "../lib/mailer";
import { buildTestApp, fakePayments, uniqueSlug } from "../test-helpers";

describe("door sales", () => {
  const stripe = fakePayments();
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp({ payments: stripe.payments });
  });

  afterAll(async () => {
    await t.close();
  });

  async function memberWithRole(
    owner: { headers: Record<string, string> },
    orgId: string,
    role: string,
  ) {
    const email = `m-${randomUUID()}@example.com`;
    await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/invitations`,
      headers: owner.headers,
      payload: { email, role },
    });
    const token = new URL(
      t.sent.findLast((m) => m.to === email)!.text.match(/https:\S+/)![0],
    ).searchParams.get("token");
    const res = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token },
    });
    return { authorization: `Bearer ${res.json().sessionToken}` };
  }

  /** An event with $15 tickets; published unless asked otherwise. */
  async function atTheDoor({ capacity = 300, quantity = 5, publish = true } = {}) {
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
        name: "Spring Dance",
        slug: uniqueSlug("dance"),
        startsAt: "2099-05-01T03:00:00.000Z",
        endsAt: "2099-05-01T09:00:00.000Z",
        capacity,
      },
    });
    const eventId = event.json().event.id as string;
    const base = `/orgs/${orgId}/events/${eventId}`;
    const ticketType = await t.app.inject({
      method: "POST",
      url: `${base}/ticket-types`,
      headers: owner.headers,
      // Online sales have ended, which doesn't stop selling at the door.
      payload: {
        name: "Door",
        priceCents: 1500,
        quantity,
        maxPerOrder: 2,
        salesEndAt: "2020-01-01T00:00:00.000Z",
      },
    });
    const ticketTypeId = ticketType.json().ticketType.id as string;
    if (publish) {
      await t.app.inject({
        method: "POST",
        url: `${base}/status`,
        headers: owner.headers,
        payload: { status: "PUBLISHED" },
      });
    }
    const sell = (payload: Record<string, unknown>, headers = owner.headers) =>
      t.app.inject({
        method: "POST",
        url: `${base}/door-sales`,
        headers,
        payload: {
          saleKey: randomUUID(),
          ticketTypeId,
          quantity: 1,
          firstName: "Jo",
          lastName: "Park",
          ...payload,
        },
      });
    const report = (headers = owner.headers, before?: string) =>
      t.app.inject({
        method: "GET",
        url: `${base}/door-sales${before ? `?before=${before}` : ""}`,
        headers,
      });
    return { owner, orgId, eventId, base, ticketTypeId, sell, report };
  }

  it("sells tickets for cash and emails them when the buyer gives an address", async () => {
    const door = await atTheDoor();
    const email = `buyer-${randomUUID()}@example.com`;
    const res = await door.sell({ quantity: 3, email: email.toUpperCase() });
    expect(res.statusCode).toBe(201);
    const { sale } = res.json();
    expect(sale).toMatchObject({
      status: "PAID",
      buyerName: "Jo Park",
      buyerEmail: email,
      totalCents: 4500,
      soldBy: { name: "Test Staff" },
    });
    expect(sale.tickets).toHaveLength(3);

    const stored = await t.prisma.order.findUniqueOrThrow({
      where: { id: sale.id },
      include: { tickets: true },
    });
    // No card, so no card or service fees.
    expect(stored).toMatchObject({
      paymentMethod: "CASH",
      subtotalCents: 4500,
      feeCents: 0,
      serviceFeeCents: 0,
      platformFeeCents: 0,
    });
    expect(stored.tickets.every((tk) => tk.status === "VALID")).toBe(true);

    const mails = t.sent.filter((m) => m.to === email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe("Your tickets for Spring Dance");
    expect(mails[0]!.text).toContain("Total paid: $45.00");
  });

  it("sells without an email, and never tries to send one", async () => {
    const door = await atTheDoor();
    const before = t.sent.length;
    const res = await door.sell({ email: null });
    expect(res.statusCode).toBe(201);
    expect(res.json().sale.buyerEmail).toBeNull();
    expect(t.sent.length).toBe(before);

    const sent: MailMessage[] = [];
    await orderConfirmations({
      prisma: t.prisma,
      mailer: { send: async (m) => void sent.push(m) },
      webBaseUrl: "https://dashboard.test",
      log: t.app.log,
    }).retry();
    const stored = await t.prisma.order.findUniqueOrThrow({ where: { id: res.json().sale.id } });
    expect(stored.confirmationAttempts).toBe(0);
    expect(sent.some((m) => !m.to)).toBe(false);
  });

  it("adds up the cash taken, leaving out sales that were cancelled", async () => {
    const door = await atTheDoor();
    await door.sell({ quantity: 2 });
    const refunded = (await door.sell({})).json().sale;
    const cancel = await t.app.inject({
      method: "POST",
      url: `${door.base}/orders/${refunded.id}/cancel`,
      headers: door.owner.headers,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().order).toMatchObject({
      status: "CANCELLED",
      paymentMethod: "CASH",
      tickets: [{ status: "VOID" }],
    });

    const { sales, cashCents, saleCount } = (await door.report()).json();
    expect(cashCents).toBe(3000);
    expect(saleCount).toBe(1);
    expect(sales.map((s: { status: string }) => s.status)).toEqual(["CANCELLED", "PAID"]);
  });

  it("records a sale sent twice only once", async () => {
    const door = await atTheDoor();
    const saleKey = randomUUID();
    const first = await door.sell({ saleKey, quantity: 2 });
    expect(first.statusCode).toBe(201);
    const again = await door.sell({ saleKey, quantity: 2 });
    expect(again.statusCode).toBe(200);
    expect(again.json().sale.id).toBe(first.json().sale.id);
    const { cashCents, saleCount } = (await door.report()).json();
    expect({ cashCents, saleCount }).toEqual({ cashCents: 3000, saleCount: 1 });

    // A key can't be borrowed for another event.
    const other = await atTheDoor();
    const elsewhere = await other.sell({ saleKey });
    expect(elsewhere.statusCode).toBe(409);
    expect((await other.report()).json().saleCount).toBe(0);
  });

  it("pages back through older sales", async () => {
    const door = await atTheDoor({ quantity: 60 });
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) ids.push((await door.sell({})).json().sale.id);
    const first = (await door.report()).json();
    expect(first.sales).toHaveLength(50);
    expect(first.more).toBe(true);
    expect(first.saleCount).toBe(52);
    const last = first.sales.at(-1).id as string;
    const older = (await door.report(door.owner.headers, last)).json();
    expect(older.more).toBe(false);
    const seen = [...first.sales, ...older.sales].map((s: { id: string }) => s.id);
    expect(seen.sort()).toEqual([...ids].sort());
    expect((await door.report(door.owner.headers, "nope")).statusCode).toBe(400);
  });

  it("lets door staff sell and see the takings, but not outsiders", async () => {
    const door = await atTheDoor();
    const staff = await memberWithRole(door.owner, door.orgId, "DOOR_STAFF");
    expect((await door.sell({}, staff)).statusCode).toBe(201);
    expect((await door.report(staff)).json().cashCents).toBe(1500);
    const stranger = await t.signIn();
    expect((await door.sell({}, stranger.headers)).statusCode).toBe(404);
    expect((await door.report(stranger.headers)).statusCode).toBe(404);
  });

  it("stops at the ticket type's limit and the event's capacity", async () => {
    const limited = await atTheDoor({ quantity: 2 });
    const tooMany = await limited.sell({ quantity: 3 });
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().error).toBe("Only 2 Door tickets are left");
    expect((await limited.sell({ quantity: 2 })).statusCode).toBe(201);
    expect((await limited.sell({})).json().error).toBe("Door tickets are sold out");

    const small = await atTheDoor({ capacity: 1 });
    expect((await small.sell({ quantity: 2 })).json().error).toBe(
      "Only 1 tickets are left for this event",
    );
    expect((await small.sell({})).statusCode).toBe(201);
    expect((await small.sell({})).json().error).toBe("The event is at capacity");
  });

  it("only sells for published events, and checks the form", async () => {
    const draft = await atTheDoor({ publish: false });
    const res = await draft.sell({});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Publish the event before selling tickets");

    const door = await atTheDoor();
    expect((await door.sell({ quantity: 0 })).statusCode).toBe(400);
    expect((await door.sell({ quantity: 21 })).statusCode).toBe(400);
    expect((await door.sell({ firstName: " " })).statusCode).toBe(400);
    expect((await door.sell({ email: "not-an-email" })).statusCode).toBe(400);
    expect((await door.sell({ ticketTypeId: randomUUID() })).statusCode).toBe(400);
  });
});
