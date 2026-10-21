import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancellationNotices, MAX_CANCELLATION_ATTEMPTS } from "../lib/cancellations";
import type { MailMessage } from "../lib/mailer";
import { buildTestApp, fakePayments, uniqueSlug } from "../test-helpers";

describe("orders", () => {
  const stripe = fakePayments();
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp({ payments: stripe.payments });
  });

  afterAll(async () => {
    await t.close();
  });

  /** A published event taking card payments, with three $10 tickets and a free type. */
  async function onSale() {
    const owner = await t.signIn();
    const orgSlug = uniqueSlug("ths");
    const org = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High School", slug: orgSlug, type: "SCHOOL" },
    });
    const orgId = org.json().organization.id as string;
    await t.prisma.organization.update({
      where: { id: orgId },
      data: {
        stripeAccountId: `acct_${orgSlug}`,
        stripeLivemode: false,
        stripeChargesEnabled: true,
      },
    });
    const eventSlug = uniqueSlug("prom");
    const event = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: {
        name: "After Prom",
        slug: eventSlug,
        startsAt: "2099-05-01T03:00:00.000Z",
        endsAt: "2099-05-01T09:00:00.000Z",
        capacity: 300,
      },
    });
    const eventId = event.json().event.id as string;
    const base = `/orgs/${orgId}/events/${eventId}`;
    const addTicket = async (payload: Record<string, unknown>) =>
      (
        await t.app.inject({
          method: "POST",
          url: `${base}/ticket-types`,
          headers: owner.headers,
          payload: { maxPerOrder: 4, ...payload },
        })
      ).json().ticketType.id as string;
    const general = await addTicket({ name: "General", priceCents: 1000, quantity: 3 });
    const free = await addTicket({ name: "Volunteer", priceCents: 0 });
    await t.app.inject({
      method: "POST",
      url: `${base}/status`,
      headers: owner.headers,
      payload: { status: "PUBLISHED" },
    });

    const buy = async (ticketTypeId: string, names: string[], buyerEmail = buyer()) => {
      const res = await t.app.inject({
        method: "POST",
        url: `/public/events/${orgSlug}/${eventSlug}/checkout`,
        payload: {
          buyerName: "Pat Parent",
          buyerEmail,
          tickets: names.map((firstName) => ({ ticketTypeId, firstName, lastName: "Lee" })),
        },
      });
      expect(res.statusCode).toBe(201);
      return { ...(res.json() as { orderId: string; key: string }), buyerEmail };
    };
    const view = (orderId: string, key: string) =>
      t.app.inject({ method: "POST", url: `/public/orders/${orderId}`, payload: { key } });
    /** A card order Stripe has confirmed as paid. */
    const paid = async (names = ["Sam"]) => {
      const order = await buy(general, names);
      const { stripeCheckoutSessionId } = await t.prisma.order.findUniqueOrThrow({
        where: { id: order.orderId },
      });
      stripe.pay(stripeCheckoutSessionId!);
      expect((await view(order.orderId, order.key)).json().order.status).toBe("PAID");
      return order;
    };
    const list = (q?: string, headers = owner.headers) =>
      t.app.inject({
        method: "GET",
        url: `${base}/orders${q === undefined ? "" : `?${new URLSearchParams({ q })}`}`,
        headers,
      });
    const cancel = (orderId: string, headers = owner.headers) =>
      t.app.inject({ method: "POST", url: `${base}/orders/${orderId}/cancel`, headers });
    const sold = async () =>
      (await t.app.inject({ method: "GET", url: `${base}/ticket-types`, headers: owner.headers }))
        .json()
        .ticketTypes.find((tt: { id: string }) => tt.id === general).sold as number;
    return { orgId, eventId, base, owner, general, free, buy, view, paid, list, cancel, sold };
  }

  const buyer = () => `buyer-${randomUUID()}@example.com`;
  const mailTo = (email: string) => t.sent.filter((m) => m.to === email);

  it("lists paid orders with their attendees, newest first, and leaves out unpaid checkouts", async () => {
    const shop = await onSale();
    const first = await shop.paid(["Sam", "Alex"]);
    await shop.buy(shop.general, ["Never Paid"]);
    const second = await shop.buy(shop.free, ["Jo"]);

    const res = await shop.list();
    expect(res.statusCode).toBe(200);
    const { orders, more } = res.json();
    expect(more).toBe(false);
    expect(orders.map((o: { id: string }) => o.id)).toEqual([second.orderId, first.orderId]);
    expect(orders[1]).toMatchObject({
      status: "PAID",
      paymentMethod: "CARD",
      buyerEmail: first.buyerEmail,
      totalCents: 2000,
      refundedCents: 0,
    });
    const tickets = orders[1].tickets as {
      status: string;
      ticketType: { name: string };
      attendee: { firstName: string };
    }[];
    expect(tickets.map((tk) => tk.attendee.firstName).sort()).toEqual(["Alex", "Sam"]);
    expect(tickets.every((tk) => tk.status === "VALID" && tk.ticketType.name === "General")).toBe(
      true,
    );
  });

  it("finds orders by buyer, attendee or email", async () => {
    const shop = await onSale();
    const sam = await shop.buy(shop.free, ["Samantha"]);
    const jo = await shop.buy(shop.free, ["Jo"]);
    const ids = async (q: string) =>
      (await shop.list(q)).json().orders.map((o: { id: string }) => o.id);
    expect(await ids("samANTHA")).toEqual([sam.orderId]);
    expect(await ids(jo.buyerEmail.slice(0, 20))).toEqual([jo.orderId]);
    expect(await ids("pat parent")).toEqual([jo.orderId, sam.orderId]);
    // A full name matches across first and last names.
    expect(await ids("  Samantha   LEE ")).toEqual([sam.orderId]);
    expect(await ids("samantha parent")).toEqual([sam.orderId]);
    expect(await ids("samantha jo")).toEqual([]);
    expect(await ids("nobody")).toEqual([]);
    expect((await shop.list("x".repeat(101))).statusCode).toBe(400);
  });

  it("refunds a card order in full, voids its tickets and tells the buyer", async () => {
    const shop = await onSale();
    const order = await shop.paid(["Sam", "Alex"]);
    expect(await shop.sold()).toBe(2);
    const { stripePaymentIntentId } = await t.prisma.order.findUniqueOrThrow({
      where: { id: order.orderId },
    });

    const res = await shop.cancel(order.orderId);
    expect(res.statusCode).toBe(200);
    expect(res.json().order).toMatchObject({
      status: "REFUNDED",
      refundedCents: 2000,
      cancelledBy: { name: "Test Staff" },
      tickets: [{ status: "VOID" }, { status: "VOID" }],
    });
    expect(stripe.refunds.get(order.orderId)).toMatchObject({
      paymentIntentId: stripePaymentIntentId,
    });
    const stored = await t.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(stored.stripeRefundId).toBe(stripe.refunds.get(order.orderId)!.id);
    // The seats go back on sale.
    expect(await shop.sold()).toBe(0);

    const emails = mailTo(order.buyerEmail).filter((m) => m.subject.includes("refunded"));
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe("Your tickets for After Prom were refunded");
    expect(emails[0]!.text).toContain("$20.00 is on its way back to the card you paid with");
    expect(emails[0]!.idempotencyKey).toBe(`order-cancelled-${order.orderId}`);

    // The buyer's order page says what happened.
    const page = (await shop.view(order.orderId, order.key)).json().order;
    expect(page).toMatchObject({ status: "REFUNDED", refundedCents: 2000 });
    expect(page.cancelledAt).not.toBeNull();
  });

  it("refunds once, however many times staff click", async () => {
    const shop = await onSale();
    const order = await shop.paid();
    const [a, b] = await Promise.all([shop.cancel(order.orderId), shop.cancel(order.orderId)]);
    // Whichever finishes second either saw the order still paid (200) or already refunded (409).
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect([200, 409]).toContain(codes[1]);
    expect(stripe.refunds.has(order.orderId)).toBe(true);
    expect(mailTo(order.buyerEmail).filter((m) => m.subject.includes("refunded"))).toHaveLength(1);

    const again = await shop.cancel(order.orderId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("This order is already cancelled");
  });

  it("leaves the order as it was when Stripe can't refund it", async () => {
    const shop = await onSale();
    const order = await shop.paid();
    stripe.failures.refund = true;
    const res = await shop.cancel(order.orderId);
    expect(res.statusCode).toBe(502);
    const stored = await t.prisma.order.findUniqueOrThrow({
      where: { id: order.orderId },
      include: { tickets: true },
    });
    expect(stored).toMatchObject({ status: "PAID", cancelledAt: null });
    expect(stored.tickets.map((tk) => tk.status)).toEqual(["VALID"]);
    expect(mailTo(order.buyerEmail).filter((m) => m.subject.includes("refunded"))).toHaveLength(0);

    expect((await shop.cancel(order.orderId)).json().order.status).toBe("REFUNDED");
  });

  it("cancels free and comp orders without a refund", async () => {
    const shop = await onSale();
    const order = await shop.buy(shop.free, ["Jo"]);
    const res = await shop.cancel(order.orderId);
    expect(res.json().order).toMatchObject({
      status: "CANCELLED",
      refundedCents: 0,
      tickets: [{ status: "VOID" }],
    });
    expect(stripe.refunds.has(order.orderId)).toBe(false);
    const [email] = mailTo(order.buyerEmail).filter((m) => m.subject.includes("cancelled"));
    expect(email!.subject).toBe("Your ticket for After Prom was cancelled");
    expect(email!.text).not.toContain("on its way back");
    // Staff cancellations stay on the list; the buyer's page doesn't call it unfinished.
    expect((await shop.list()).json().orders.map((o: { id: string }) => o.id)).toContain(
      order.orderId,
    );
    expect((await shop.view(order.orderId, order.key)).json().order.cancelledAt).not.toBeNull();

    const comp = await t.app.inject({
      method: "POST",
      url: `${shop.base}/comps`,
      headers: shop.owner.headers,
      payload: { ticketTypeId: shop.general, firstName: "Chap", lastName: "Erone", email: buyer() },
    });
    const compId = comp.json().comp.id as string;
    expect((await shop.cancel(compId)).json().order).toMatchObject({ status: "CANCELLED" });

    // A comp voided before cancellations were recorded still shows up.
    const old = await t.app.inject({
      method: "POST",
      url: `${shop.base}/comps`,
      headers: shop.owner.headers,
      payload: { ticketTypeId: shop.general, firstName: "Old", lastName: "Comp", email: buyer() },
    });
    const oldId = old.json().comp.id as string;
    await t.prisma.order.update({ where: { id: oldId }, data: { status: "CANCELLED" } });
    expect((await shop.list()).json().orders.map((o: { id: string }) => o.id)).toContain(oldId);
  });

  it("won't record a refund Stripe says failed", async () => {
    const shop = await onSale();
    const order = await shop.paid();
    stripe.refundOutcome.status = "failed";
    try {
      const res = await shop.cancel(order.orderId);
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("Stripe couldn't refund this payment. Check it in Stripe.");
    } finally {
      stripe.refundOutcome.status = "succeeded";
    }
    const stored = await t.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(stored).toMatchObject({ status: "PAID", cancelledAt: null });
  });

  it("records a refund that's still pending at Stripe", async () => {
    const shop = await onSale();
    const order = await shop.paid();
    stripe.refundOutcome.status = "pending";
    try {
      expect((await shop.cancel(order.orderId)).json().order.status).toBe("REFUNDED");
    } finally {
      stripe.refundOutcome.status = "succeeded";
    }
    const stored = await t.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(stored.stripeRefundStatus).toBe("pending");
  });

  it("waits for a confirmation email that's going out", async () => {
    const shop = await onSale();
    const order = await shop.buy(shop.free, ["Jo"]);
    await t.prisma.order.update({
      where: { id: order.orderId },
      data: { confirmationClaimedAt: new Date() },
    });
    const res = await shop.cancel(order.orderId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/going out right now/);
    const stored = await t.prisma.order.findUniqueOrThrow({
      where: { id: order.orderId },
      include: { tickets: true },
    });
    expect(stored.status).toBe("PAID");
    expect(stored.tickets.map((tk) => tk.status)).toEqual(["VALID"]);

    await t.prisma.order.update({
      where: { id: order.orderId },
      data: { confirmationClaimedAt: null },
    });
    expect((await shop.cancel(order.orderId)).json().order.status).toBe("CANCELLED");
  });

  it("retries the cancellation email when it couldn't be sent", async () => {
    const shop = await onSale();
    const order = await shop.paid();
    t.mailFailures.remaining = 1;
    expect((await shop.cancel(order.orderId)).json().order.status).toBe("REFUNDED");
    const refunded = (m: MailMessage) => m.subject.includes("refunded");
    expect(mailTo(order.buyerEmail).filter(refunded)).toHaveLength(0);
    const stored = await t.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(stored.cancellationEmail).not.toBeNull();

    const sent: MailMessage[] = [];
    const notices = cancellationNotices({
      prisma: t.prisma,
      mailer: { send: async (m) => void sent.push(m) },
      log: t.app.log,
    });
    await notices.retry();
    const mine = sent.filter((m) => m.to === order.buyerEmail);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.idempotencyKey).toBe(`order-cancelled-${order.orderId}`);
    expect(mine[0]!.text).toContain("$10.00 is on its way back");
    const after = await t.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(after.cancellationEmail).toBeNull();
    await notices.retry();
    expect(sent.filter((m) => m.to === order.buyerEmail)).toHaveLength(1);
  });

  it("sends a cancellation email once, even with two senders at once", async () => {
    const shop = await onSale();
    const order = await shop.buy(shop.free, ["Jo"]);
    t.mailFailures.remaining = 1;
    await shop.cancel(order.orderId);
    const sent: MailMessage[] = [];
    const notices = cancellationNotices({
      prisma: t.prisma,
      mailer: { send: async (m) => void sent.push(m) },
      log: t.app.log,
    });
    await Promise.all([notices.send(order.orderId), notices.send(order.orderId), notices.retry()]);
    expect(sent.filter((m) => m.to === order.buyerEmail)).toHaveLength(1);
  });

  it("leaves a cancellation email being sent alone, but takes over an abandoned one", async () => {
    const shop = await onSale();
    const order = await shop.buy(shop.free, ["Jo"]);
    t.mailFailures.remaining = 1;
    await shop.cancel(order.orderId);
    const sent: MailMessage[] = [];
    const notices = cancellationNotices({
      prisma: t.prisma,
      mailer: { send: async (m) => void sent.push(m) },
      log: t.app.log,
    });
    await t.prisma.order.update({
      where: { id: order.orderId },
      data: { cancellationClaimedAt: new Date() },
    });
    await notices.retry();
    expect(sent.filter((m) => m.to === order.buyerEmail)).toHaveLength(0);
    await t.prisma.order.update({
      where: { id: order.orderId },
      data: { cancellationClaimedAt: new Date(Date.now() - 11 * 60_000) },
    });
    await notices.retry();
    expect(sent.filter((m) => m.to === order.buyerEmail)).toHaveLength(1);
  });

  it("stops retrying a cancellation email after a few failed attempts", async () => {
    const shop = await onSale();
    const order = await shop.buy(shop.free, ["Jo"]);
    t.mailFailures.remaining = 1;
    await shop.cancel(order.orderId);
    let attempts = 1;
    const notices = cancellationNotices({
      prisma: t.prisma,
      mailer: {
        send: async (m) => {
          if (m.to !== order.buyerEmail) return;
          attempts++;
          throw new Error("Mailbox unavailable");
        },
      },
      log: t.app.log,
    });
    for (let i = 0; i <= MAX_CANCELLATION_ATTEMPTS; i++) await notices.send(order.orderId);
    expect(attempts).toBe(MAX_CANCELLATION_ATTEMPTS);
    const stored = await t.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(stored).toMatchObject({
      cancellationEmail: null,
      cancellationAttempts: MAX_CANCELLATION_ATTEMPTS,
      cancellationClaimedAt: null,
    });
  });

  it("gives up on a cancellation email after a day", async () => {
    const shop = await onSale();
    const order = await shop.buy(shop.free, ["Jo"]);
    t.mailFailures.remaining = 1;
    await shop.cancel(order.orderId);
    await t.prisma.order.update({
      where: { id: order.orderId },
      data: { cancelledAt: new Date(Date.now() - 24 * 60 * 60_000) },
    });
    const sent: MailMessage[] = [];
    await cancellationNotices({
      prisma: t.prisma,
      mailer: { send: async (m) => void sent.push(m) },
      log: t.app.log,
    }).retry();
    expect(sent.filter((m) => m.to === order.buyerEmail)).toHaveLength(0);
    const stored = await t.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(stored.cancellationEmail).toBeNull();
  });

  it("keeps who voided a comp and when if it's voided again", async () => {
    const shop = await onSale();
    const comp = await t.app.inject({
      method: "POST",
      url: `${shop.base}/comps`,
      headers: shop.owner.headers,
      payload: { ticketTypeId: shop.general, firstName: "Chap", lastName: "Erone", email: buyer() },
    });
    const compId = comp.json().comp.id as string;
    const voidIt = (headers = shop.owner.headers) =>
      t.app.inject({ method: "POST", url: `${shop.base}/comps/${compId}/void`, headers });
    expect((await voidIt()).statusCode).toBe(200);
    const first = await t.prisma.order.findUniqueOrThrow({ where: { id: compId } });

    const admin = await t.signIn();
    await t.prisma.membership.create({
      data: { organizationId: shop.orgId, userId: admin.userId, role: "ADMIN" },
    });
    const again = await voidIt(admin.headers);
    expect(again.statusCode).toBe(200);
    expect(again.json().comp.status).toBe("CANCELLED");
    const second = await t.prisma.order.findUniqueOrThrow({ where: { id: compId } });
    expect(second.cancelledAt).toEqual(first.cancelledAt);
    expect(second.cancelledById).toBe(shop.owner.userId);
  });

  it("won't cancel an order that's still being paid for", async () => {
    const shop = await onSale();
    const order = await shop.buy(shop.general, ["Sam"]);
    const res = await shop.cancel(order.orderId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/still being paid for/);
  });

  it("is limited to staff who manage the organization's events", async () => {
    const shop = await onSale();
    const order = await shop.paid();
    const door = await t.signIn();
    await t.prisma.membership.create({
      data: { organizationId: shop.orgId, userId: door.userId, role: "DOOR_STAFF" },
    });
    expect((await shop.list(undefined, door.headers)).statusCode).toBe(403);
    expect((await shop.cancel(order.orderId, door.headers)).statusCode).toBe(403);

    // Another organization's order isn't found through this event.
    const other = await onSale();
    const theirs = await other.paid();
    expect((await shop.cancel(theirs.orderId)).statusCode).toBe(404);
    expect(stripe.refunds.has(theirs.orderId)).toBe(false);
  });
});
