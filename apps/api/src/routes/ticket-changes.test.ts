import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderConfirmations } from "../lib/confirmations";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("editing, transferring and resending tickets", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  /** A school with a free students-only prom for grades 11 and 12, and a free guest ticket. */
  async function school() {
    const owner = await t.signIn();
    const orgSlug = uniqueSlug("ths");
    const org = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High School", slug: orgSlug, type: "SCHOOL" },
    });
    const orgId = org.json().organization.id as string;
    const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: owner.headers, payload });
    const startsAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    const eventSlug = uniqueSlug("prom");
    const event = await call("POST", `/orgs/${orgId}/events`, {
      name: "Prom",
      slug: eventSlug,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 4 * 60 * 60_000).toISOString(),
    });
    const eventId = event.json().event.id as string;
    const base = `/orgs/${orgId}/events/${eventId}`;
    const type = async (payload: object) =>
      (
        await call("POST", `${base}/ticket-types`, { priceCents: 0, maxPerOrder: 4, ...payload })
      ).json().ticketType.id as string;
    const prom = await type({ name: "Prom", studentsOnly: true, minGrade: 11, maxGrade: 12 });
    const guest = await type({ name: "Guest", quantity: 2, askEmergencyInfo: true });
    await call("POST", `${base}/status`, { status: "PUBLISHED" });
    const emergency = { contactName: "Pat Parent", contactPhone: "(555) 010-0000" };
    /** Buys tickets and returns the order with its tickets, oldest first. */
    const buy = async (tickets: object[], buyerEmail = `buyer-${randomUUID()}@example.com`) => {
      const res = await t.app.inject({
        method: "POST",
        url: `/public/events/${orgSlug}/${eventSlug}/checkout`,
        payload: { buyerName: "Pat Parent", buyerEmail, tickets },
      });
      expect(res.statusCode).toBe(201);
      const { orderId, key } = res.json() as { orderId: string; key: string };
      // Listed in the order the tickets were asked for, matched by first name.
      const issued = await t.prisma.ticket.findMany({
        where: { orderId },
        select: { id: true, attendee: { select: { firstName: true } } },
      });
      const ticketIds = (tickets as { firstName: string }[]).map(
        (asked) => issued.find((x) => x.attendee.firstName === asked.firstName)!.id,
      );
      return { orderId, key, buyerEmail, ticketIds };
    };
    return { owner, orgId, eventId, base, call, buy, prom, guest, emergency };
  }

  it("corrects an attendee's name and emergency info, keeping the ticket", async () => {
    const s = await school();
    const { orderId, ticketIds } = await s.buy([
      { ticketTypeId: s.guest, firstName: "Sma", lastName: "Lee", emergency: s.emergency },
    ]);
    const before = await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketIds[0] } });
    const url = `${s.base}/tickets/${ticketIds[0]}`;

    // The type asks for emergency info, so it can't be dropped.
    const missing = await s.call("PATCH", url, { firstName: "Sam", lastName: "Lee" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("Give an emergency contact for Sam");

    const res = await s.call("PATCH", url, {
      firstName: " Sam ",
      lastName: "Lee",
      emergency: { ...s.emergency, medicalNotes: "Peanuts" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().attendee).toEqual({
      firstName: "Sam",
      lastName: "Lee",
      emergencyContactName: "Pat Parent",
      emergencyContactPhone: "+15550100000",
      medicalNotes: "Peanuts",
    });
    const { order, studentRoster } = (await s.call("GET", `${s.base}/orders/${orderId}`)).json();
    expect(studentRoster).toBe(false);
    expect(order.tickets[0]).toMatchObject({
      ticketType: { name: "Guest", studentsOnly: false, askEmergencyInfo: true },
      attendee: { firstName: "Sam", studentId: null, medicalNotes: "Peanuts" },
    });
    const after = await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketIds[0] } });
    expect(after.code).toBe(before.code);
    expect(after.status).toBe("VALID");
  });

  it("keeps a roster-matched ticket with its student", async () => {
    const s = await school();
    await s.call("PUT", `/orgs/${s.orgId}/roster`, {
      csv: "id,first,last,grade\nS-1,Sam,Lee,11\nS-2,Jo,Park,12\nS-3,Al,Ng,9\n",
    });
    const { ticketIds } = await s.buy([
      { ticketTypeId: s.prom, firstName: "Sam", lastName: "Lee", studentId: "S-1" },
    ]);
    const res = await s.call("PATCH", `${s.base}/tickets/${ticketIds[0]}`, {
      firstName: "Jo",
      lastName: "Park",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("To give this ticket to someone else, transfer it");
    // The first name and the last name's spelling are fine to fix.
    const fixed = await s.call("PATCH", `${s.base}/tickets/${ticketIds[0]}`, {
      firstName: "Samuel",
      lastName: "LEE",
    });
    expect(fixed.statusCode).toBe(200);
  });

  it("transfers a ticket to a new attendee with a new QR code, and emails it to them", async () => {
    const s = await school();
    // Both guest tickets are sold, and the transfer still goes through.
    const { orderId, key, ticketIds } = await s.buy([
      { ticketTypeId: s.guest, firstName: "Sam", lastName: "Lee", emergency: s.emergency },
      { ticketTypeId: s.guest, firstName: "Kim", lastName: "Lee", emergency: s.emergency },
    ]);
    const old = await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketIds[0] } });
    // A waiver added since: the new holder hasn't signed it, so it shows as missing.
    const waiver = await t.prisma.waiverTemplate.create({
      data: { organizationId: s.orgId, title: "Rules", body: "Behave." },
    });
    await t.prisma.ticketTypeWaiver.create({
      data: { ticketTypeId: s.guest, waiverTemplateId: waiver.id },
    });
    const url = `${s.base}/tickets/${ticketIds[0]}/transfer`;
    const email = `jo-${randomUUID()}@example.com`;
    const res = await s.call("POST", url, {
      firstName: "Jo",
      lastName: "Park",
      email: ` ${email.toUpperCase()} `,
      emergency: s.emergency,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().emailed).toBe(true);
    const newId = res.json().ticket.id as string;

    const tickets = await t.prisma.ticket.findMany({
      where: { orderId },
      select: {
        id: true,
        status: true,
        code: true,
        waiversRequired: true,
        attendee: { select: { firstName: true, email: true } },
      },
    });
    const replaced = tickets.find((x) => x.id === ticketIds[0])!;
    const issued = tickets.find((x) => x.id === newId)!;
    expect(replaced.status).toBe("VOID");
    expect(replaced.attendee.firstName).toBe("Sam");
    expect(issued).toMatchObject({
      status: "VALID",
      waiversRequired: true,
      attendee: { firstName: "Jo", email },
    });
    expect(issued.code).not.toBe(old.code);

    const mail = t.sent.findLast((m) => m.to === email)!;
    expect(mail.subject).toBe("Your ticket for Prom");
    expect(mail.text).toContain("Hi Jo,");
    expect(mail.text).toContain("- Jo Park: Guest");
    expect(mail.inlineImages).toHaveLength(1);
    // The claim taken while it was emailed is let go.
    const order = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.confirmationClaimedAt).toBeNull();
    // The buyer's order page shows who has the tickets now.
    const page = await t.app.inject({
      method: "POST",
      url: `/public/orders/${orderId}`,
      payload: { key },
    });
    expect(
      page
        .json()
        .order.tickets.map((x: { firstName: string }) => x.firstName)
        .sort(),
    ).toEqual(["Jo", "Kim"]);

    // The old ticket can't be edited or moved again.
    const again = await s.call("POST", url, { firstName: "Al", lastName: "Ng" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("This ticket has been cancelled or given to someone else");
    const edit = await s.call("PATCH", `${s.base}/tickets/${ticketIds[0]}`, {
      firstName: "Sam",
      lastName: "Lee",
      emergency: s.emergency,
    });
    expect(edit.statusCode).toBe(409);
  });

  it("shows a comp's new holder after a transfer", async () => {
    const s = await school();
    const comp = await s.call("POST", `${s.base}/comps`, {
      ticketTypeId: s.guest,
      firstName: "Dee",
      lastName: "Jay",
      email: `dj-${randomUUID()}@example.com`,
    });
    const ticketId = comp.json().comp.tickets[0].id as string;
    const moved = await s.call("POST", `${s.base}/tickets/${ticketId}/transfer`, {
      firstName: "Mo",
      lastName: "Vee",
      emergency: s.emergency,
    });
    expect(moved.statusCode).toBe(201);
    const { comps } = (await s.call("GET", `${s.base}/comps`)).json();
    expect(comps[0].tickets).toMatchObject([{ status: "VALID", attendee: { firstName: "Mo" } }]);
  });

  it("counts a transferred ticket once, in orders, door sales and cancellation emails", async () => {
    const s = await school();
    const door = (
      await s.call("POST", `${s.base}/ticket-types`, {
        name: "Door",
        priceCents: 500,
        maxPerOrder: 4,
      })
    ).json().ticketType.id as string;
    const email = `jo-${randomUUID()}@example.com`;
    const sale = {
      saleKey: randomUUID(),
      ticketTypeId: door,
      quantity: 1,
      firstName: "Jo",
      lastName: "Park",
      email,
    };
    const first = await s.call("POST", `${s.base}/door-sales`, sale);
    expect(first.statusCode).toBe(201);
    const orderId = first.json().sale.id as string;
    const old = await t.prisma.ticket.findFirstOrThrow({ where: { orderId } });
    const moved = await s.call("POST", `${s.base}/tickets/${old.id}/transfer`, {
      firstName: "Al",
      lastName: "Ng",
    });
    expect(moved.statusCode).toBe(201);
    const issued = await t.prisma.ticket.findUniqueOrThrow({
      where: { id: moved.json().ticket.id },
    });
    expect(issued.transferredFromId).toBe(old.id);

    // A retry of the sale is still the same sale, even once its email has been corrected.
    const fixed = `jo-fixed-${randomUUID()}@example.com`;
    const resent = await s.call("POST", `${s.base}/orders/${orderId}/resend`, { email: fixed });
    expect(resent.statusCode).toBe(200);
    const again = await s.call("POST", `${s.base}/door-sales`, sale);
    expect(again.statusCode).toBe(200);
    expect(again.json().sale.tickets).toHaveLength(1);
    const { orders } = (await s.call("GET", `${s.base}/orders`)).json();
    const listed = orders.find((o: { id: string }) => o.id === orderId);
    expect(
      listed.tickets.map((x: { transferredTo: { id: string } | null }) => x.transferredTo?.id),
    ).toEqual([issued.id, undefined]);

    expect((await s.call("POST", `${s.base}/orders/${orderId}/cancel`)).statusCode).toBe(200);
    const notice = t.sent.findLast((m) => m.to === fixed && m.text.includes("cancelled"))!;
    expect(notice.text).toContain("cancelled your ticket for Prom");
  });

  it("holds transfers of students-only tickets to the same rules as checkout", async () => {
    const s = await school();
    await s.call("PUT", `/orgs/${s.orgId}/roster`, {
      csv: "id,first,last,grade\nS-1,Sam,Lee,11\nS-2,Jo,Park,12\nS-3,Al,Ng,9\nS-4,Kim,Ho,11\n",
    });
    const { ticketIds } = await s.buy([
      { ticketTypeId: s.prom, firstName: "Sam", lastName: "Lee", studentId: "S-1" },
    ]);
    await s.buy([{ ticketTypeId: s.prom, firstName: "Kim", lastName: "Ho", studentId: "S-4" }]);
    const transfer = (payload: object) =>
      s.call("POST", `${s.base}/tickets/${ticketIds[0]}/transfer`, payload);
    const error = async (payload: object) => (await transfer(payload)).json().error as string;

    expect(await error({ firstName: "Jo", lastName: "Park" })).toBe("Enter Jo's student ID");
    expect(await error({ firstName: "Jo", lastName: "Ng", studentId: "S-2" })).toContain(
      "doesn't have student ID S-2 with the last name Ng",
    );
    expect(await error({ firstName: "Al", lastName: "Ng", studentId: "S-3" })).toBe(
      "These tickets are for grades 11–12 (Al)",
    );
    expect(await error({ firstName: "Kim", lastName: "Ho", studentId: "s-4" })).toBe(
      "Student ID S-4 already has a Prom ticket",
    );
    const ok = await transfer({ firstName: "Jo", lastName: "park", studentId: " s-2", grade: 9 });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().emailed).toBeNull();
    const attendee = await t.prisma.attendee.findFirstOrThrow({
      where: { tickets: { some: { id: ok.json().ticket.id } } },
      select: { studentId: true, grade: true },
    });
    expect(attendee).toEqual({ studentId: "S-2", grade: 12 });
    // Sam's ticket is gone, so Sam could buy another.
    await s.buy([{ ticketTypeId: s.prom, firstName: "Sam", lastName: "Lee", studentId: "S-1" }]);
  });

  it("doesn't move a ticket while it's in use or its email is still going out", async () => {
    const s = await school();
    const { orderId, ticketIds } = await s.buy([
      { ticketTypeId: s.guest, firstName: "Sam", lastName: "Lee", emergency: s.emergency },
    ]);
    const transfer = () =>
      s.call("POST", `${s.base}/tickets/${ticketIds[0]}/transfer`, {
        firstName: "Jo",
        lastName: "Park",
        emergency: s.emergency,
      });

    await t.prisma.ticket.update({ where: { id: ticketIds[0] }, data: { isInside: true } });
    expect((await transfer()).json().error).toBe(
      "This ticket's holder is at the event now, so it can't be moved",
    );
    await t.prisma.ticket.update({ where: { id: ticketIds[0] }, data: { isInside: false } });

    // An email waiting for a retry would carry the old code.
    await t.prisma.order.update({
      where: { id: orderId },
      data: { confirmationSentAt: null, confirmationEmail: { to: "x" } },
    });
    const pending = await transfer();
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error).toContain("hasn't gone out yet");
    await t.prisma.order.update({
      where: { id: orderId },
      data: { confirmationSentAt: new Date(), confirmationClaimedAt: new Date() },
    });
    expect((await transfer()).json().error).toContain("going out right now");
  });

  it("resends an order's tickets to a corrected email with a new order link", async () => {
    const s = await school();
    const { orderId, key, buyerEmail, ticketIds } = await s.buy([
      { ticketTypeId: s.guest, firstName: "Sam", lastName: "Lee", emergency: s.emergency },
      { ticketTypeId: s.guest, firstName: "Kim", lastName: "Lee", emergency: s.emergency },
    ]);
    expect(t.sent.filter((m) => m.to === buyerEmail)).toHaveLength(1);
    await s.call("POST", `${s.base}/tickets/${ticketIds[1]}/transfer`, {
      firstName: "Jo",
      lastName: "Park",
      emergency: s.emergency,
    });

    const email = `fixed-${randomUUID()}@example.com`;
    const url = `${s.base}/orders/${orderId}/resend`;
    expect((await s.call("POST", url, { email: "nope" })).statusCode).toBe(400);
    const res = await s.call("POST", url, { email });
    expect(res.statusCode).toBe(200);
    const mail = t.sent.findLast((m) => m.to === email)!;
    // The tickets as they are now: the transferred one is the new holder's.
    expect(mail.text).toContain("- Sam Lee: Guest\n- Jo Park: Guest");
    expect(mail.inlineImages).toHaveLength(2);
    const order = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.buyerEmail).toBe(email);
    expect(order.confirmationClaimedAt).toBeNull();

    // The old link stops working and the new one opens the order.
    const view = (k: string) =>
      t.app.inject({ method: "POST", url: `/public/orders/${orderId}`, payload: { key: k } });
    expect((await view(key)).statusCode).toBe(404);
    const newKey = new URL(mail.text.match(/https:\S+/)![0]).searchParams.get("key")!;
    expect((await view(newKey)).statusCode).toBe(200);
  });

  it("says when the email couldn't be sent, and leaves the confirmation to go out right", async () => {
    const s = await school();
    const ticket = { ticketTypeId: s.guest, firstName: "Sam", lastName: "Lee" };
    const view = (orderId: string, key: string) =>
      t.app.inject({ method: "POST", url: `/public/orders/${orderId}`, payload: { key } });

    // A confirmation never tried goes out by the usual retries, with the new address and link.
    const fresh = await s.buy([{ ...ticket, emergency: s.emergency }]);
    await t.prisma.order.update({
      where: { id: fresh.orderId },
      data: { confirmationSentAt: null, confirmationAttempts: 0, confirmationFirstTriedAt: null },
    });
    const email = `fixed-${randomUUID()}@example.com`;
    t.mailFailures.remaining = 1;
    const failed = await s.call("POST", `${s.base}/orders/${fresh.orderId}/resend`, { email });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe("The email couldn't be sent. Try again in a minute.");
    const pending = await t.prisma.order.findUniqueOrThrow({ where: { id: fresh.orderId } });
    expect(pending).toMatchObject({
      buyerEmail: email,
      confirmationSentAt: null,
      confirmationClaimedAt: null,
      confirmationAttempts: 0,
    });
    // A confirmation that was handed the old key before the resend fails, such as a buyer
    // opening their order just then, still sends the new one.
    const confirmations = orderConfirmations({
      prisma: t.prisma,
      mailer: { send: async (m) => void t.sent.push(m) },
      webBaseUrl: "https://dashboard.test",
      log: t.app.log,
    });
    await confirmations.confirm(fresh.orderId, fresh.key);
    const retried = t.sent.findLast((m) => m.to === email)!;
    const link = new URL(retried.text.match(/https:\S+/)![0]);
    expect(link.searchParams.get("key")).toBe(pending.emailViewKey);
    // The old link no longer opens the order, and the new one does.
    expect((await view(fresh.orderId, fresh.key)).statusCode).toBe(404);
    expect((await view(fresh.orderId, pending.emailViewKey!)).statusCode).toBe(200);

    // One already tried may be held by the provider under its key, so retries stop and staff
    // send it from here.
    t.mailFailures.remaining = 1;
    const tried = await s.buy([{ ...ticket, emergency: s.emergency }]);
    const url = `${s.base}/orders/${tried.orderId}/resend`;
    t.mailFailures.remaining = 1;
    expect((await s.call("POST", url, { email: tried.buyerEmail })).statusCode).toBe(502);
    let order = await t.prisma.order.findUniqueOrThrow({ where: { id: tried.orderId } });
    expect(order).toMatchObject({
      confirmationSentAt: null,
      confirmationClaimedAt: null,
      confirmationAttempts: 5,
      emailViewKey: null,
      confirmationEmail: null,
    });
    expect((await s.call("POST", url, { email: tried.buyerEmail })).statusCode).toBe(200);
    order = await t.prisma.order.findUniqueOrThrow({ where: { id: tried.orderId } });
    expect(order.confirmationSentAt).not.toBeNull();
  });

  it("is for staff who manage events, on orders that still stand", async () => {
    const s = await school();
    const { orderId, buyerEmail, ticketIds } = await s.buy([
      { ticketTypeId: s.guest, firstName: "Sam", lastName: "Lee", emergency: s.emergency },
    ]);
    const email = `m-${randomUUID()}@example.com`;
    await s.call("POST", `/orgs/${s.orgId}/invitations`, { email, role: "DOOR_STAFF" });
    const token = new URL(
      t.sent.findLast((m) => m.to === email)!.text.match(/https:\S+/)![0],
    ).searchParams.get("token");
    const accepted = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token },
    });
    const door = { authorization: `Bearer ${accepted.json().sessionToken}` };
    const as = (headers: Record<string, string>, url: string, payload: object) =>
      t.app.inject({ method: "POST", url, headers, payload });
    const resend = `${s.base}/orders/${orderId}/resend`;
    expect((await as(door, resend, { email: buyerEmail })).statusCode).toBe(403);
    const stranger = (await t.signIn()).headers;
    expect((await as(stranger, resend, { email: buyerEmail })).statusCode).toBe(404);

    expect((await s.call("POST", `${s.base}/orders/${orderId}/cancel`)).statusCode).toBe(200);
    const cancelled = await s.call("POST", resend, { email: buyerEmail });
    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.json().error).toBe("This order is cancelled");
    const edit = await s.call("PATCH", `${s.base}/tickets/${ticketIds[0]}`, {
      firstName: "Sam",
      lastName: "Lee",
    });
    expect(edit.statusCode).toBe(409);
    // Another event's ticket isn't found here.
    const other = await school();
    expect(
      (
        await other.call("PATCH", `${other.base}/tickets/${ticketIds[0]}`, {
          firstName: "Sam",
          lastName: "Lee",
        })
      ).statusCode,
    ).toBe(404);
  });
});
