import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, fakePayments, uniqueSlug } from "../test-helpers";

describe("checkout", () => {
  const stripe = fakePayments();
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp({ payments: stripe.payments });
  });

  afterAll(async () => {
    await t.close();
  });

  /** A published event whose organization can take card payments unless told otherwise. */
  async function onSale({
    ready = true,
    capacity = 300,
  }: { ready?: boolean; capacity?: number | null } = {}) {
    const owner = await t.signIn();
    const orgSlug = uniqueSlug("ths");
    const org = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High School", slug: orgSlug, type: "SCHOOL" },
    });
    const orgId = org.json().organization.id as string;
    const accountId = `acct_${orgSlug}`;
    if (ready) {
      await t.prisma.organization.update({
        where: { id: orgId },
        data: { stripeAccountId: accountId, stripeLivemode: false, stripeChargesEnabled: true },
      });
    }
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
        capacity,
      },
    });
    const eventId = event.json().event.id as string;
    const base = `/orgs/${orgId}/events/${eventId}`;
    // Publishing needs a ticket type, so the first one added publishes the event.
    let published = false;
    const addTicket = async (payload: Record<string, unknown> = {}) => {
      const res = await t.app.inject({
        method: "POST",
        url: `${base}/ticket-types`,
        headers: owner.headers,
        payload: { name: "General", priceCents: 1000, maxPerOrder: 4, ...payload },
      });
      if (!published) {
        await t.app.inject({
          method: "POST",
          url: `${base}/status`,
          headers: owner.headers,
          payload: { status: "PUBLISHED" },
        });
        published = true;
      }
      return res.json().ticketType.id as string;
    };
    const addPromo = (payload: Record<string, unknown>) =>
      t.app.inject({
        method: "POST",
        url: `${base}/promo-codes`,
        headers: owner.headers,
        payload,
      });
    const buy = (tickets: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
      t.app.inject({
        method: "POST",
        url: `/public/events/${orgSlug}/${eventSlug}/checkout`,
        payload: { buyerName: "Pat Parent", buyerEmail: "pat@example.com", tickets, ...extra },
      });
    const view = (orderId: string, key: string) =>
      t.app.inject({ method: "POST", url: `/public/orders/${orderId}`, payload: { key } });
    const settings = (cardFeePaidBy: string, headers = owner.headers) =>
      t.app.inject({
        method: "PUT",
        url: `/orgs/${orgId}/payments/settings`,
        headers,
        payload: { cardFeePaidBy },
      });
    return { orgId, accountId, eventSlug, orgSlug, addTicket, addPromo, buy, view, settings };
  }

  const attendee = (ticketTypeId: string, firstName = "Sam", extra = {}) => ({
    ticketTypeId,
    firstName,
    lastName: "Lee",
    ...extra,
  });

  const sessionOf = async (orderId: string) =>
    (await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).stripeCheckoutSessionId!;

  it("holds seats while the buyer pays, then issues the tickets", async () => {
    const shop = await onSale();
    const general = await shop.addTicket();
    const res = await shop.buy([attendee(general, "Sam"), attendee(general, "Alex")]);
    expect(res.statusCode).toBe(201);
    const { orderId, key, paymentUrl } = res.json();
    expect(paymentUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);

    const session = await sessionOf(orderId);
    const request = stripe.checkouts.get(session)!;
    // The school covers the fee by default: the buyer pays face value and the school gets it,
    // less what Stripe will keep.
    expect(request).toMatchObject({
      accountId: shop.accountId,
      orderId,
      buyerEmail: "pat@example.com",
      applicationFeeCents: 88,
      lines: [{ name: "After Prom: 2 tickets", amountCents: 2000 }],
    });
    expect(request.successUrl).toBe(
      `https://dashboard.test/e/${shop.orgSlug}/${shop.eventSlug}/orders/${orderId}?key=${key}`,
    );

    const pending = (await shop.view(orderId, key)).json().order;
    expect(pending).toMatchObject({ status: "PENDING", totalCents: 2000, feeCents: 0 });
    expect(pending.tickets.map((tk: { status: string }) => tk.status)).toEqual(["HELD", "HELD"]);

    stripe.pay(session);
    const paid = (await shop.view(orderId, key)).json().order;
    expect(paid.status).toBe("PAID");
    // Tickets made in one go share a timestamp, so their order isn't fixed.
    expect(paid.tickets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "VALID", firstName: "Sam", ticketTypeName: "General" }),
        expect.objectContaining({ status: "VALID", firstName: "Alex", ticketTypeName: "General" }),
      ]),
    );
    const stored = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(stored.stripePaymentIntentId).toMatch(/^pi_/);
  });

  it("adds the card fee to the total when the organization passes it on", async () => {
    const shop = await onSale();
    const general = await shop.addTicket();
    expect((await shop.settings("BUYER")).statusCode).toBe(200);
    const { orderId, key } = (await shop.buy([attendee(general)])).json();
    const order = (await shop.view(orderId, key)).json().order;
    expect(order).toMatchObject({ subtotalCents: 1000, feeCents: 61, totalCents: 1061 });
    expect(stripe.checkouts.get(await sessionOf(orderId))).toMatchObject({
      applicationFeeCents: 61,
      lines: [
        { name: "After Prom: 1 ticket", amountCents: 1000 },
        { name: "Card processing fee", amountCents: 61 },
      ],
    });
  });

  it("lets only owners choose who pays the card fee", async () => {
    const shop = await onSale();
    const stranger = await t.signIn();
    expect((await shop.settings("BUYER", stranger.headers)).statusCode).toBe(404);
    expect((await shop.settings("SOMEONE")).statusCode).toBe(400);
  });

  it("issues free tickets straight away, even before Stripe is set up", async () => {
    const shop = await onSale({ ready: false });
    const free = await shop.addTicket({ name: "Chaperone", priceCents: 0 });
    const res = await shop.buy([attendee(free)]);
    expect(res.statusCode).toBe(201);
    expect(res.json().paymentUrl).toBeNull();
    const order = (await shop.view(res.json().orderId, res.json().key)).json().order;
    expect(order).toMatchObject({ status: "PAID", totalCents: 0, tickets: [{ status: "VALID" }] });
  });

  it("refuses paid tickets until the organization can take payments", async () => {
    const shop = await onSale({ ready: false });
    const general = await shop.addTicket();
    const res = await shop.buy([attendee(general)]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("This event isn't taking card payments yet");
  });

  const lapse = (orderId: string) =>
    t.prisma.order.update({
      where: { id: orderId },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });

  it("holds seats until Stripe confirms the payment page closed unpaid", async () => {
    const shop = await onSale();
    const general = await shop.addTicket({ quantity: 2 });
    const first = (await shop.buy([attendee(general, "A"), attendee(general, "B")])).json();

    const blocked = await shop.buy([attendee(general, "C")]);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("General tickets are sold out");

    // The hold lapses but Stripe's page is somehow still open: the seats stay taken.
    await lapse(first.orderId);
    expect((await shop.buy([attendee(general, "C")])).statusCode).toBe(409);

    // Once Stripe says the page closed unpaid, the next checkout after the retry gets them.
    stripe.expire(await sessionOf(first.orderId));
    await lapse(first.orderId);
    expect((await shop.buy([attendee(general, "C")])).statusCode).toBe(201);
    const lapsed = (await shop.view(first.orderId, first.key)).json().order;
    expect(lapsed.status).toBe("CANCELLED");
    expect(lapsed.tickets.map((tk: { status: string }) => tk.status)).toEqual(["VOID", "VOID"]);
  });

  it("settles the other lapsed orders when Stripe can't find one", async () => {
    const shop = await onSale();
    const general = await shop.addTicket({ quantity: 2 });
    const lost = (await shop.buy([attendee(general, "A")])).json();
    const abandoned = (await shop.buy([attendee(general, "B")])).json();
    await t.prisma.order.update({
      where: { id: lost.orderId },
      data: { stripeCheckoutSessionId: `cs_test_missing_${lost.orderId}` },
    });
    await lapse(lost.orderId);
    await lapse(abandoned.orderId);
    stripe.expire(await sessionOf(abandoned.orderId));

    expect((await shop.buy([attendee(general, "C")])).statusCode).toBe(201);
    const statuses = await t.prisma.order.findMany({
      where: { id: { in: [lost.orderId, abandoned.orderId] } },
      select: { id: true, status: true },
    });
    expect(Object.fromEntries(statuses.map((o) => [o.id, o.status]))).toEqual({
      [lost.orderId]: "PENDING",
      [abandoned.orderId]: "CANCELLED",
    });
  });

  it("moves orders Stripe can't settle out of the way of later ones", async () => {
    const shop = await onSale();
    const general = await shop.addTicket({ quantity: 13 });
    const lost: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { orderId } = (await shop.buy([attendee(general, `Lost${i}`)])).json();
      await t.prisma.order.update({
        where: { id: orderId },
        data: {
          stripeCheckoutSessionId: `cs_test_missing_${orderId}`,
          holdExpiresAt: new Date(Date.now() - 60_000),
        },
      });
      lost.push(orderId);
    }
    const abandoned = (await shop.buy([attendee(general, "B")])).json();
    await lapse(abandoned.orderId);
    stripe.expire(await sessionOf(abandoned.orderId));

    // The first checkout only reaches the ten oldest, which Stripe can't find; the next one
    // gets past them to the abandoned order.
    expect((await shop.buy([attendee(general, "C")])).statusCode).toBe(201);
    expect((await shop.buy([attendee(general, "D")])).statusCode).toBe(201);
    const orders = await t.prisma.order.findMany({
      where: { id: { in: [...lost, abandoned.orderId] } },
      select: { id: true, status: true, holdExpiresAt: true },
    });
    const byId = new Map(orders.map((o) => [o.id, o]));
    expect(byId.get(abandoned.orderId)!.status).toBe("CANCELLED");
    for (const id of lost) {
      expect(byId.get(id)!.status).toBe("PENDING");
      expect(byId.get(id)!.holdExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("keeps the seats of a buyer who paid but never came back", async () => {
    const shop = await onSale();
    const general = await shop.addTicket({ quantity: 1 });
    const { orderId, key } = (await shop.buy([attendee(general)])).json();
    stripe.pay(await sessionOf(orderId));
    await lapse(orderId);

    // The next buyer's checkout settles the lapsed order as paid instead of reselling its seat.
    const next = await shop.buy([attendee(general, "Other")]);
    expect(next.json().error).toBe("General tickets are sold out");
    const order = (await shop.view(orderId, key)).json().order;
    expect(order).toMatchObject({ status: "PAID", tickets: [{ status: "VALID" }] });
  });

  it("gives the seats back when the buyer backs out of Stripe's page", async () => {
    const shop = await onSale();
    const general = await shop.addTicket({ quantity: 1 });
    const { orderId, key } = (await shop.buy([attendee(general)])).json();
    const session = await sessionOf(orderId);
    expect(stripe.checkouts.get(session)!.cancelUrl).toBe(
      `https://dashboard.test/e/${shop.orgSlug}/${shop.eventSlug}/checkout?cancelled=${orderId}&key=${key}`,
    );

    const cancel = (k = key) =>
      t.app.inject({
        method: "POST",
        url: `/public/orders/${orderId}/cancel`,
        payload: { key: k },
      });
    expect((await cancel("wrong-key")).statusCode).toBe(404);
    expect((await cancel()).json().order.status).toBe("CANCELLED");
    expect(stripe.checkouts.get(session)!.state.status).toBe("expired");
    expect((await shop.buy([attendee(general)])).statusCode).toBe(201);
  });

  it("doesn't cancel an order that was paid before the buyer backed out", async () => {
    const shop = await onSale();
    const general = await shop.addTicket();
    const { orderId, key } = (await shop.buy([attendee(general)])).json();
    stripe.pay(await sessionOf(orderId));
    const res = await t.app.inject({
      method: "POST",
      url: `/public/orders/${orderId}/cancel`,
      payload: { key },
    });
    expect(res.json().order.status).toBe("PAID");
  });

  it("refuses a card payment below Stripe's minimum", async () => {
    const shop = await onSale();
    const general = await shop.addTicket();
    await shop.addPromo({ code: "ALMOST", discountType: "AMOUNT", discountValue: 990 });
    const res = await shop.buy([attendee(general)], { promoCode: "ALMOST" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Card payments have to be at least $0.50");
  });

  it("lets the seats go when Stripe's payment page closes unpaid", async () => {
    const shop = await onSale();
    const general = await shop.addTicket({ quantity: 1 });
    const { orderId, key } = (await shop.buy([attendee(general)])).json();
    stripe.expire(await sessionOf(orderId));
    const order = (await shop.view(orderId, key)).json().order;
    expect(order).toMatchObject({ status: "CANCELLED", tickets: [{ status: "VOID" }] });
    expect((await shop.buy([attendee(general)])).statusCode).toBe(201);
  });

  it("stops at the event's capacity", async () => {
    const shop = await onSale({ capacity: 1 });
    const general = await shop.addTicket();
    const res = await shop.buy([attendee(general, "A"), attendee(general, "B")]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Only 1 tickets are left for this event");
  });

  it("applies a promo code and counts unpaid orders against its uses", async () => {
    const shop = await onSale();
    const general = await shop.addTicket();
    await shop.addPromo({ code: "EARLY", discountType: "PERCENT", discountValue: 25, maxUses: 1 });
    const { orderId, key } = (await shop.buy([attendee(general)], { promoCode: "early" })).json();
    const order = (await shop.view(orderId, key)).json().order;
    expect(order).toMatchObject({ subtotalCents: 1000, discountCents: 250, totalCents: 750 });

    const again = await shop.buy([attendee(general)], { promoCode: "EARLY" });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("That code has been used up");
    const unknown = await shop.buy([attendee(general)], { promoCode: "NOPE" });
    expect(unknown.json().error).toBe("That code doesn't work for this event");
  });

  it("issues the tickets without payment when a code covers the whole order", async () => {
    const shop = await onSale();
    const general = await shop.addTicket();
    await shop.addPromo({ code: "STAFF", discountType: "PERCENT", discountValue: 100 });
    const res = await shop.buy([attendee(general)], { promoCode: "STAFF" });
    expect(res.json().paymentUrl).toBeNull();
    const order = (await shop.view(res.json().orderId, res.json().key)).json().order;
    expect(order).toMatchObject({ status: "PAID", discountCents: 1000, totalCents: 0 });
  });

  it("checks who each ticket is for", async () => {
    const shop = await onSale();
    const seniors = await shop.addTicket({ name: "Senior", studentsOnly: true, minGrade: 12 });
    const guest = await shop.addTicket({ name: "Guest", requiresApproval: true });

    const tooYoung = await shop.buy([attendee(seniors, "Sam", { grade: 11 })]);
    expect(tooYoung.statusCode).toBe(400);
    expect(tooYoung.json().error).toBe("These tickets are for grades 12 and up (Sam)");
    const noGrade = await shop.buy([attendee(seniors, "Sam")]);
    expect(noGrade.json().error).toBe("Enter the student's grade (Sam)");
    expect((await shop.buy([attendee(seniors, "Sam", { grade: 12 })])).statusCode).toBe(201);

    const guestPass = await shop.buy([attendee(guest)]);
    expect(guestPass.statusCode).toBe(400);
    expect(guestPass.json().error).toMatch(/need the school's approval/);
  });

  it("accepts ticket type ids in upper case", async () => {
    const shop = await onSale();
    const general = await shop.addTicket();
    expect((await shop.buy([attendee(general.toUpperCase())])).statusCode).toBe(201);
  });

  it("keeps to the per-order limit", async () => {
    const shop = await onSale();
    const general = await shop.addTicket({ maxPerOrder: 1 });
    const res = await shop.buy([attendee(general, "A"), attendee(general, "B")]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("You can buy up to 1 General tickets per order");
  });

  it("lets the seats go when Stripe can't open the payment page", async () => {
    const shop = await onSale();
    const general = await shop.addTicket({ quantity: 1 });
    stripe.failures.checkout = true;
    expect((await shop.buy([attendee(general)])).statusCode).toBe(500);
    expect((await shop.buy([attendee(general)])).statusCode).toBe(201);
  });

  it("only shows an order to someone with its link", async () => {
    const shop = await onSale();
    const general = await shop.addTicket();
    const { orderId } = (await shop.buy([attendee(general)])).json();
    expect((await shop.view(orderId, "wrong-key")).statusCode).toBe(404);
  });

  it("tells the event page whether card payments are on", async () => {
    const ready = await onSale();
    await ready.addTicket();
    const notReady = await onSale({ ready: false });
    await notReady.addTicket();
    const page = (shop: { orgSlug: string; eventSlug: string }) =>
      t.app.inject({ method: "GET", url: `/public/events/${shop.orgSlug}/${shop.eventSlug}` });
    expect((await page(ready)).json().event).toMatchObject({
      onlinePayments: true,
      cardFeePaidBy: "ORGANIZATION",
    });
    expect((await page(notReady)).json().event.onlinePayments).toBe(false);
  });
});

describe("checkout rate limit", () => {
  it("limits how many checkouts one client can start", async () => {
    const t = await buildTestApp({ checkoutPerIpPerMinute: 1 });
    const buy = () =>
      t.app.inject({ method: "POST", url: "/public/events/nope/nope/checkout", payload: {} });
    expect((await buy()).statusCode).toBe(400);
    expect((await buy()).statusCode).toBe(429);
    await t.close();
  });
});
