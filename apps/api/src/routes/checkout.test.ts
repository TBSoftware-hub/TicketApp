import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_CONFIRMATION_ATTEMPTS, orderConfirmations } from "../lib/confirmations";
import type { MailMessage } from "../lib/mailer";
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
    const settings = (cardFeePaidBy: string, serviceFeePaidBy = "BUYER", headers = owner.headers) =>
      t.app.inject({
        method: "PUT",
        url: `/orgs/${orgId}/payments/settings`,
        headers,
        payload: { cardFeePaidBy, serviceFeePaidBy },
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
    // By default the buyer pays the service fee and the school covers the card fee, which comes
    // out of what it gets along with the service fee.
    expect(request).toMatchObject({
      accountId: shop.accountId,
      orderId,
      buyerEmail: "pat@example.com",
      applicationFeeCents: 92 + 150,
      lines: [
        { name: "After Prom: 2 tickets", amountCents: 2000 },
        { name: "Service fee", amountCents: 150 },
      ],
    });
    expect(request.successUrl).toBe(
      `https://dashboard.test/e/${shop.orgSlug}/${shop.eventSlug}/orders/${orderId}?key=${key}`,
    );

    const pending = (await shop.view(orderId, key)).json().order;
    expect(pending).toMatchObject({
      status: "PENDING",
      totalCents: 2150,
      serviceFeeCents: 150,
      feeCents: 0,
    });
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
    expect(order).toMatchObject({
      subtotalCents: 1000,
      serviceFeeCents: 75,
      feeCents: 64,
      totalCents: 1139,
    });
    expect(stripe.checkouts.get(await sessionOf(orderId))).toMatchObject({
      applicationFeeCents: 64 + 75,
      lines: [
        { name: "After Prom: 1 ticket", amountCents: 1000 },
        { name: "Service fee", amountCents: 75 },
        { name: "Card processing fee", amountCents: 64 },
      ],
    });
  });

  it("keeps the service fee out of the price when the organization covers it", async () => {
    const shop = await onSale();
    const general = await shop.addTicket();
    const free = await shop.addTicket({ name: "Chaperone", priceCents: 0 });
    expect((await shop.settings("ORGANIZATION", "ORGANIZATION")).statusCode).toBe(200);
    const { orderId, key } = (await shop.buy([attendee(general), attendee(free, "Alex")])).json();
    const order = (await shop.view(orderId, key)).json().order;
    expect(order).toMatchObject({ totalCents: 1000, serviceFeeCents: 0, feeCents: 0 });
    // The free ticket carries no service fee.
    expect(stripe.checkouts.get(await sessionOf(orderId))).toMatchObject({
      applicationFeeCents: 59 + 75,
      lines: [{ name: "After Prom: 2 tickets", amountCents: 1000 }],
    });
  });

  it("lets only owners choose who pays the fees", async () => {
    const shop = await onSale();
    const stranger = await t.signIn();
    expect((await shop.settings("BUYER", "BUYER", stranger.headers)).statusCode).toBe(404);
    expect((await shop.settings("SOMEONE")).statusCode).toBe(400);
    expect((await shop.settings("BUYER", "SOMEONE")).statusCode).toBe(400);
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
    await shop.settings("ORGANIZATION", "ORGANIZATION");
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
    expect(order).toMatchObject({ subtotalCents: 1000, discountCents: 250, totalCents: 825 });

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
      serviceFeePaidBy: "BUYER",
    });
    expect((await page(notReady)).json().event.onlinePayments).toBe(false);
  });

  describe("confirmation email", () => {
    const buyer = () => `buyer-${randomUUID()}@example.com`;
    const mailTo = (email: string) => t.sent.filter((m) => m.to === email);
    const codesOf = async (orderId: string) =>
      (
        await t.prisma.ticket.findMany({
          where: { orderId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { code: true },
        })
      ).map((tk) => tk.code);

    it("emails free tickets straight away with a QR code each and a working order link", async () => {
      const shop = await onSale({ ready: false });
      const free = await shop.addTicket({ name: "Chaperone", priceCents: 0 });
      const email = buyer();
      const res = await shop.buy([attendee(free, "Sam"), attendee(free, "Alex")], {
        buyerEmail: email,
      });
      const { orderId } = res.json();

      const [mail, ...rest] = mailTo(email);
      expect(rest).toHaveLength(0);
      expect(mail!.subject).toBe("Your tickets for After Prom");
      expect(mail!.text).toContain("- Sam Lee: Chaperone");
      expect(mail!.text).toContain("- Alex Lee: Chaperone");
      expect(mail!.text).not.toContain("Total paid");
      const codes = await codesOf(orderId);
      expect(mail!.inlineImages!.map((i) => i.contentId)).toEqual(["ticket-1", "ticket-2"]);
      expect(mail!.html).toContain('src="cid:ticket-1"');
      // Each image is the QR code for that ticket's code, in the same order as the names.
      for (const [i, image] of mail!.inlineImages!.entries()) {
        const expected = await QRCode.toBuffer(codes[i]!, { type: "png", width: 240, margin: 2 });
        expect(image.content.equals(expected)).toBe(true);
      }

      const link = new URL(mail!.text.match(/Your order: (\S+)/)![1]!);
      expect(link.pathname).toBe(`/e/${shop.orgSlug}/${shop.eventSlug}/orders/${orderId}`);
      const viewed = await shop.view(orderId, link.searchParams.get("key")!);
      expect(viewed.statusCode).toBe(200);
      expect(mailTo(email)).toHaveLength(1);
    });

    it("emails paid tickets once the payment is confirmed, and only once", async () => {
      const shop = await onSale();
      const general = await shop.addTicket();
      const email = buyer();
      const { orderId, key } = (await shop.buy([attendee(general)], { buyerEmail: email })).json();
      expect(mailTo(email)).toHaveLength(0);
      await shop.view(orderId, key);
      expect(mailTo(email)).toHaveLength(0);

      stripe.pay(await sessionOf(orderId));
      await shop.view(orderId, key);
      await shop.view(orderId, key);
      const mails = mailTo(email);
      expect(mails).toHaveLength(1);
      expect(mails[0]!.subject).toBe("Your ticket for After Prom");
      expect(mails[0]!.text).toContain("Total paid: $10.75");
      expect(mails[0]!.text).toContain(`orders/${orderId}?key=${key}`);
      // The key is only kept until the email carries it.
      const order = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.emailViewKey).toBeNull();
      expect(order.confirmationSentAt).not.toBeNull();
    });

    it("emails a buyer who paid but never came back once their order is settled", async () => {
      const shop = await onSale();
      const general = await shop.addTicket({ quantity: 2 });
      const email = buyer();
      const { orderId, key } = (await shop.buy([attendee(general)], { buyerEmail: email })).json();
      stripe.pay(await sessionOf(orderId));
      await lapse(orderId);

      await shop.buy([attendee(general, "Other")]);
      const [mail] = mailTo(email);
      expect(mail!.text).toContain(`orders/${orderId}?key=${key}`);
    });

    it("tries again when the email couldn't be sent", async () => {
      const shop = await onSale();
      const general = await shop.addTicket();
      const email = buyer();
      const { orderId, key } = (await shop.buy([attendee(general)], { buyerEmail: email })).json();
      stripe.pay(await sessionOf(orderId));

      t.mailFailures.remaining = 1;
      const first = await shop.view(orderId, key);
      expect(first.statusCode).toBe(200);
      expect(first.json().order.status).toBe("PAID");
      expect(mailTo(email)).toHaveLength(0);

      await shop.view(orderId, key);
      expect(mailTo(email)).toHaveLength(1);
    });

    it("resends the first attempt's email unchanged, even after the event is edited", async () => {
      const shop = await onSale({ ready: false });
      const free = await shop.addTicket({ priceCents: 0 });
      const email = buyer();
      t.mailFailures.remaining = 1;
      const { orderId, key } = (await shop.buy([attendee(free)], { buyerEmail: email })).json();
      const { eventId } = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const { name } = await t.prisma.event.update({
        where: { id: eventId },
        data: { name: "Renamed Night" },
        select: { name: true },
      });
      expect(name).toBe("Renamed Night");

      // The provider would reject a different message under the same idempotency key.
      await shop.view(orderId, key);
      const [sent] = mailTo(email);
      expect(sent!.subject).not.toContain("Renamed Night");
      expect(sent!.inlineImages!.map((i) => i.contentId)).toEqual(["ticket-1"]);
      const order = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.confirmationEmail).toBeNull();
    });

    it("retries a failed email on an order more than a week old", async () => {
      const shop = await onSale({ ready: false });
      const free = await shop.addTicket({ priceCents: 0 });
      const email = buyer();
      t.mailFailures.remaining = 1;
      const { orderId } = (await shop.buy([attendee(free)], { buyerEmail: email })).json();
      await t.prisma.order.update({
        where: { id: orderId },
        data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) },
      });

      const sent: MailMessage[] = [];
      const sweep = orderConfirmations({
        prisma: t.prisma,
        mailer: { send: async (m) => void sent.push(m) },
        webBaseUrl: "https://dashboard.test",
        log: t.app.log,
      });
      await sweep.retry();
      expect(sent.filter((m) => m.to === email)).toHaveLength(1);
    });

    it("still issues free tickets when the email can't be sent", async () => {
      const shop = await onSale({ ready: false });
      const free = await shop.addTicket({ priceCents: 0 });
      const email = buyer();
      t.mailFailures.remaining = 1;
      const res = await shop.buy([attendee(free)], { buyerEmail: email });
      expect(res.statusCode).toBe(201);
      const { orderId, key } = res.json();
      expect(mailTo(email)).toHaveLength(0);

      // The order link's key is kept for the retry, which can come from the background sweep.
      const order = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.emailViewKey).toBe(key);
    });

    it("retries unsent emails in the background, for buyers who never come back", async () => {
      const shop = await onSale();
      const general = await shop.addTicket({ quantity: 2 });
      const email = buyer();
      const { orderId } = (await shop.buy([attendee(general)], { buyerEmail: email })).json();
      stripe.pay(await sessionOf(orderId));
      await lapse(orderId);
      // The next checkout settles the order as paid, but the email fails.
      t.mailFailures.remaining = 1;
      await shop.buy([attendee(general, "Other")]);
      expect(mailTo(email)).toHaveLength(0);

      const sent: MailMessage[] = [];
      const sweep = orderConfirmations({
        prisma: t.prisma,
        mailer: { send: async (m) => void sent.push(m) },
        webBaseUrl: "https://dashboard.test",
        log: t.app.log,
      });
      await sweep.retry();
      const mine = sent.filter((m) => m.to === email);
      expect(mine).toHaveLength(1);
      // Every attempt carries the same key, so the provider drops a repeat.
      expect(mine[0]!.idempotencyKey).toBe(`order-confirmation-${orderId}`);
      expect(mine[0]!.text).toContain(`orders/${orderId}?key=`);
    });

    it("takes over a send that was abandoned partway, but not one in progress", async () => {
      const shop = await onSale({ ready: false });
      const free = await shop.addTicket({ priceCents: 0 });
      const email = buyer();
      t.mailFailures.remaining = 1;
      const { orderId, key } = (await shop.buy([attendee(free)], { buyerEmail: email })).json();

      await t.prisma.order.update({
        where: { id: orderId },
        data: { confirmationClaimedAt: new Date() },
      });
      await shop.view(orderId, key);
      expect(mailTo(email)).toHaveLength(0);

      await t.prisma.order.update({
        where: { id: orderId },
        data: { confirmationClaimedAt: new Date(Date.now() - 11 * 60_000) },
      });
      await shop.view(orderId, key);
      expect(mailTo(email)).toHaveLength(1);
    });

    it("stops retrying a day after the first attempt, however later attempts went", async () => {
      const shop = await onSale({ ready: false });
      const free = await shop.addTicket({ priceCents: 0 });
      const email = buyer();
      // The first attempt's response is lost: the provider may have delivered it.
      t.mailFailures.remaining = 1;
      const { orderId, key } = (await shop.buy([attendee(free)], { buyerEmail: email })).json();
      const first = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(first.confirmationFirstTriedAt).not.toBeNull();
      expect(first.confirmationClaimedAt).toBeNull();

      // A day of downtime later, its idempotency key has been forgotten, so nothing is resent.
      await t.prisma.order.update({
        where: { id: orderId },
        data: { confirmationFirstTriedAt: new Date(Date.now() - 25 * 60 * 60_000) },
      });
      await shop.view(orderId, key);
      const sweep = orderConfirmations({
        prisma: t.prisma,
        mailer: { send: async () => {} },
        webBaseUrl: "https://dashboard.test",
        log: t.app.log,
      });
      await sweep.retry();
      expect(mailTo(email)).toHaveLength(0);
      const order = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order).toMatchObject({
        confirmationSentAt: null,
        emailViewKey: null,
        confirmationEmail: null,
      });
      // Taking over abandoned claims doesn't move the deadline either.
      expect(order.confirmationAttempts).toBe(1);
    });

    it("keeps the first attempt's time when later attempts take over", async () => {
      const shop = await onSale({ ready: false });
      const free = await shop.addTicket({ priceCents: 0 });
      const email = buyer();
      t.mailFailures.remaining = 2;
      const { orderId, key } = (await shop.buy([attendee(free)], { buyerEmail: email })).json();
      const before = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      await shop.view(orderId, key);
      const after = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(after.confirmationAttempts).toBe(2);
      expect(after.confirmationFirstTriedAt).toEqual(before.confirmationFirstTriedAt);
    });

    it("stops retrying after a few failed attempts", async () => {
      const shop = await onSale();
      const general = await shop.addTicket();
      const email = buyer();
      const { orderId, key } = (await shop.buy([attendee(general)], { buyerEmail: email })).json();
      stripe.pay(await sessionOf(orderId));
      t.mailFailures.remaining = MAX_CONFIRMATION_ATTEMPTS;
      for (let i = 0; i <= MAX_CONFIRMATION_ATTEMPTS; i++) await shop.view(orderId, key);
      expect(t.mailFailures.remaining).toBe(0);
      expect(mailTo(email)).toHaveLength(0);
      const order = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order).toMatchObject({
        confirmationSentAt: null,
        confirmationAttempts: MAX_CONFIRMATION_ATTEMPTS,
        emailViewKey: null,
        confirmationEmail: null,
      });
    });

    it("sends nothing for an order that was never paid and drops its key", async () => {
      const shop = await onSale();
      const general = await shop.addTicket();
      const email = buyer();
      const { orderId, key } = (await shop.buy([attendee(general)], { buyerEmail: email })).json();
      await t.app.inject({
        method: "POST",
        url: `/public/orders/${orderId}/cancel`,
        payload: { key },
      });
      expect(mailTo(email)).toHaveLength(0);
      const order = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order).toMatchObject({ status: "CANCELLED", emailViewKey: null });
    });
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
