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
    const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
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
    const scan = (
      code: string,
      headers = owner.headers,
      base = prom.base,
      scanKey: string = randomUUID(),
      overrideReason?: string,
    ) =>
      t.app.inject({
        method: "POST",
        url: `${base}/scans`,
        headers,
        payload: { scanKey, code, overrideReason },
      });

    /** Scans a code with any of the scan's other fields, such as a check-out or an override. */
    const send = (code: string, fields: object = {}, headers = owner.headers) =>
      t.app.inject({
        method: "POST",
        url: `${prom.base}/scans`,
        headers,
        payload: { scanKey: randomUUID(), code, ...fields },
      });

    return { owner, orgId, call, newEvent, prom, comp, scan, send };
  }

  /** Comps a ticket whose type asks for a waiver, which its holder hasn't signed yet. */
  async function waiverParty() {
    const p = await party();
    const waiver = await t.prisma.waiverTemplate.create({
      data: { organizationId: p.orgId, title: "Rules", body: "Behave." },
    });
    await t.prisma.ticketTypeWaiver.create({
      data: { ticketTypeId: p.prom.guest, waiverTemplateId: waiver.id },
    });
    const sign = (ticketId: string) =>
      t.prisma.waiverSignature.create({
        data: {
          ticketId,
          waiverTemplateId: waiver.id,
          templateVersion: 1,
          signerRole: "ATTENDEE",
          signerName: "Signer",
          documentHash: "x",
        },
      });
    return { ...p, sign };
  }

  const reason = "Signed a paper waiver at the door";

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
      payload: { scanKey: randomUUID(), code },
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

  it("lets a ticket in when the address spells the ids in capitals", async () => {
    const p = await party();
    const { code } = await p.comp("Pia");
    const res = await p.scan(
      code,
      p.owner.headers,
      p.prom.base.toUpperCase().replace("/ORGS/", "/orgs/").replace("/EVENTS/", "/events/"),
    );
    expect(res.json().outcome).toBe("admitted");
  });

  it("answers a retried admission the same way when its first answer was lost", async () => {
    const p = await party();
    const { ticketId, code } = await p.comp("Quin");
    const scanKey = randomUUID();
    const admitted = {
      outcome: "admitted",
      ticket: { attendeeName: "Quin Lee", ticketTypeName: "Guest" },
    };
    expect((await p.scan(code, p.owner.headers, p.prom.base, scanKey)).json()).toEqual(admitted);
    expect((await p.scan(code, p.owner.headers, p.prom.base, scanKey)).json()).toEqual(admitted);
    // The retry adds nothing to the record; a genuinely new scan is still turned away.
    const scans = await t.prisma.scanEvent.findMany({ where: { ticketId } });
    expect(scans).toMatchObject([{ outcome: "ADMITTED", scanKey }]);
    expect((await p.scan(code)).json().outcome).toBe("already_inside");
  });

  it("answers a retry racing its original as admitted too", async () => {
    const p = await party();
    const { code } = await p.comp("Rae");
    const scanKey = randomUUID();
    const results = await Promise.all([
      p.scan(code, p.owner.headers, p.prom.base, scanKey),
      p.scan(code, p.owner.headers, p.prom.base, scanKey),
    ]);
    expect(results.map((r) => r.json().outcome)).toEqual(["admitted", "admitted"]);
  });

  it("won't replay another ticket's or another staff member's admission", async () => {
    const p = await party();
    const first = await p.comp("Sol");
    const second = await p.comp("Tam");
    const scanKey = randomUUID();
    await p.scan(first.code, p.owner.headers, p.prom.base, scanKey);
    const unused = await p.comp("Ula");
    const fresh = await p.scan(unused.code, p.owner.headers, p.prom.base, scanKey);
    expect(fresh.statusCode).toBe(409);
    // Turned away without letting the unused ticket's holder in.
    const ticket = await t.prisma.ticket.findUniqueOrThrow({ where: { id: unused.ticketId } });
    expect(ticket.isInside).toBe(false);
    await p.scan(second.code);
    const reused = await p.scan(second.code, p.owner.headers, p.prom.base, scanKey);
    expect(reused.statusCode).toBe(409);

    const door = await t.signIn();
    await t.prisma.membership.create({
      data: { userId: door.userId, organizationId: p.orgId, role: "DOOR_STAFF" },
    });
    const other = await p.scan(first.code, door.headers, p.prom.base, scanKey);
    expect(other.statusCode).toBe(409);
  });

  it("turns away a long QR code that isn't a ticket, rather than rejecting the scan", async () => {
    const p = await party();
    const vcard = `BEGIN:VCARD\nNOTE:${"x".repeat(1000)}\nEND:VCARD`;
    expect((await p.scan(vcard)).json()).toEqual({ outcome: "invalid_ticket", reason: "unknown" });
  });

  it("turns away a QR code with a zero byte in it, and records the scan", async () => {
    const p = await party();
    const res = await p.scan("abc\u0000def");
    expect(res.json()).toEqual({ outcome: "invalid_ticket", reason: "unknown" });
    const scans = await t.prisma.scanEvent.findMany({ where: { eventId: p.prom.eventId } });
    expect(scans).toMatchObject([{ ticketId: null, outcome: "INVALID_TICKET" }]);
  });

  it("needs a scan key, so retries can be told apart from new scans", async () => {
    const p = await party();
    const { code } = await p.comp("Uma");
    const res = await t.app.inject({
      method: "POST",
      url: `${p.prom.base}/scans`,
      headers: p.owner.headers,
      payload: { code },
    });
    expect(res.statusCode).toBe(400);
  });

  it("holds up a ticket whose waiver isn't signed, and records the scan", async () => {
    const p = await waiverParty();
    const { ticketId, code } = await p.comp("Val");
    const res = await p.scan(code);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      outcome: "waiver_missing",
      ticket: { attendeeName: "Val Lee", ticketTypeName: "Guest" },
      reason: "not_signed",
    });
    const ticket = await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.isInside).toBe(false);
    const scans = await t.prisma.scanEvent.findMany({ where: { ticketId } });
    expect(scans).toMatchObject([
      { outcome: "WAIVER_MISSING", overrideReason: null, scanKey: null },
    ]);
    // Not counted as arrived on the attendee list.
    const list = (await p.call("GET", `${p.prom.base}/attendees?checkIn=not-arrived`)).json();
    expect(list.attendees).toMatchObject([{ firstName: "Val", waiver: "missing" }]);
  });

  it("lets a ticket in once its waiver is signed", async () => {
    const p = await waiverParty();
    const { ticketId, code } = await p.comp("Wes");
    expect((await p.scan(code)).json().outcome).toBe("waiver_missing");
    await p.sign(ticketId);
    expect((await p.scan(code)).json().outcome).toBe("admitted");
  });

  it("holds up a minor whose guardian hasn't signed yet", async () => {
    const p = await waiverParty();
    const { ticketId, code } = await p.comp("Xia");
    await p.sign(ticketId);
    const guardian = await t.prisma.guardian.create({ data: { name: "Pat Lee" } });
    const request = await t.prisma.guardianSignatureRequest.create({
      data: { ticketId, guardianId: guardian.id, tokenHash: randomUUID() },
    });
    expect((await p.scan(code)).json()).toMatchObject({
      outcome: "waiver_missing",
      reason: "guardian_pending",
    });
    await t.prisma.guardianSignatureRequest.update({
      where: { id: request.id },
      data: { signedAt: new Date() },
    });
    expect((await p.scan(code)).json().outcome).toBe("admitted");
  });

  it("doesn't ask for a waiver the ticket type didn't need when the ticket was issued", async () => {
    const p = await party();
    const { code } = await p.comp("Yan");
    // Added after the ticket was issued, so it applies to new tickets only.
    const waiver = await t.prisma.waiverTemplate.create({
      data: { organizationId: p.orgId, title: "Rules", body: "Behave." },
    });
    await t.prisma.ticketTypeWaiver.create({
      data: { ticketTypeId: p.prom.guest, waiverTemplateId: waiver.id },
    });
    expect((await p.scan(code)).json().outcome).toBe("admitted");
  });

  it("lets staff override a missing waiver with a reason, kept on the record", async () => {
    const p = await waiverParty();
    const { ticketId, code } = await p.comp("Zed");
    await p.scan(code);
    const door = await t.signIn();
    await t.prisma.membership.create({
      data: { userId: door.userId, organizationId: p.orgId, role: "DOOR_STAFF" },
    });
    const scanKey = randomUUID();
    const res = await p.scan(code, door.headers, p.prom.base, scanKey, `  ${reason} `);
    expect(res.json()).toEqual({
      outcome: "admitted",
      ticket: { attendeeName: "Zed Lee", ticketTypeName: "Guest" },
    });
    const ticket = await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.isInside).toBe(true);
    const scans = await t.prisma.scanEvent.findMany({
      where: { ticketId },
      orderBy: { createdAt: "asc" },
    });
    expect(scans).toMatchObject([
      { outcome: "WAIVER_MISSING", overrideReason: null },
      { outcome: "WAIVER_MISSING", overrideReason: reason, staffUserId: door.userId, scanKey },
    ]);

    // A retry of the override replays it; a new scan finds them inside since the override.
    const retry = await p.scan(code, door.headers, p.prom.base, scanKey, reason);
    expect(retry.json().outcome).toBe("admitted");
    expect(await t.prisma.scanEvent.count({ where: { ticketId } })).toBe(2);
    const again = (await p.scan(code)).json();
    expect(again).toMatchObject({
      outcome: "already_inside",
      admittedAt: scans[1]!.scannedAt.toISOString(),
    });
    // Shown as inside, with the waiver still missing.
    const list = (await p.call("GET", `${p.prom.base}/attendees?checkIn=inside`)).json();
    expect(list.attendees).toMatchObject([{ firstName: "Zed", waiver: "missing" }]);
  });

  it("records a plain admission when the waiver was signed before the override arrived", async () => {
    const p = await waiverParty();
    const { ticketId, code } = await p.comp("Abe");
    await p.sign(ticketId);
    const res = await p.scan(code, p.owner.headers, p.prom.base, randomUUID(), reason);
    expect(res.json().outcome).toBe("admitted");
    const scans = await t.prisma.scanEvent.findMany({ where: { ticketId } });
    expect(scans).toMatchObject([{ outcome: "ADMITTED", overrideReason: null }]);
  });

  it("won't override anything but a waiver", async () => {
    const p = await party();
    const { orderId, ticketId, code } = await p.comp("Bea");
    await p.call("POST", `${p.prom.base}/comps/${orderId}/void`);
    const res = await p.scan(code, p.owner.headers, p.prom.base, randomUUID(), reason);
    expect(res.json()).toEqual({ outcome: "invalid_ticket", reason: "cancelled" });
    const scans = await t.prisma.scanEvent.findMany({ where: { ticketId } });
    expect(scans).toMatchObject([{ outcome: "INVALID_TICKET", overrideReason: null }]);
  });

  it("needs a real reason to override", async () => {
    const p = await waiverParty();
    const { code } = await p.comp("Cal");
    const res = await p.scan(code, p.owner.headers, p.prom.base, randomUUID(), "  ok ");
    expect(res.statusCode).toBe(400);
    const long = await p.scan(code, p.owner.headers, p.prom.base, randomUUID(), "x".repeat(501));
    expect(long.statusCode).toBe(400);
    const zero = await p.scan(
      code,
      p.owner.headers,
      p.prom.base,
      randomUUID(),
      "Paper\u0000waiver",
    );
    expect(zero.statusCode).toBe(400);
  });

  it("rejects an empty scan", async () => {
    const p = await party();
    expect((await p.scan("   ")).statusCode).toBe(400);
  });
  describe("check-out and re-entry", () => {
    const out = { direction: "out" };
    const ann = { attendeeName: "Ann Lee", ticketTypeName: "Guest" };
    const backIn = "Parent or guardian brought them back";
    const allowReentry = (p: Awaited<ReturnType<typeof party>>) =>
      p.call("PATCH", p.prom.base, { reentryAllowed: true });

    it("checks someone out, records it, and says they can't come back in", async () => {
      const p = await party();
      const { ticketId, code } = await p.comp("Ann");
      await p.scan(code);
      const res = await p.send(code, out);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: "checked_out", ticket: ann, reentryAllowed: false });
      const ticket = await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
      expect(ticket.isInside).toBe(false);
      const scans = await t.prisma.scanEvent.findMany({
        where: { ticketId },
        orderBy: { createdAt: "asc" },
      });
      expect(scans).toMatchObject([
        { direction: "IN", outcome: "ADMITTED" },
        { direction: "OUT", outcome: "CHECKED_OUT", staffUserId: p.owner.userId },
      ]);
      expect(scans[1]!.scanKey).not.toBeNull();
    });

    it("shows a checked-out attendee in the list as left", async () => {
      const p = await party();
      const { code } = await p.comp("Ann");
      await p.scan(code);
      await p.send(code, out);
      const list = await p.call("GET", `${p.prom.base}/attendees?checkIn=left`);
      expect(list.json().attendees).toHaveLength(1);
    });

    it("keeps out someone who left an event without re-entry, saying when they left", async () => {
      const p = await party();
      const { ticketId, code } = await p.comp("Ann");
      await p.scan(code);
      await p.send(code, out);
      const left = await t.prisma.scanEvent.findFirstOrThrow({
        where: { ticketId, outcome: "CHECKED_OUT" },
      });
      const res = await p.scan(code);
      expect(res.json()).toEqual({
        outcome: "reentry_denied",
        ticket: ann,
        leftAt: left.scannedAt.toISOString(),
      });
      const denied = await t.prisma.scanEvent.findFirstOrThrow({
        where: { ticketId, outcome: "REENTRY_DENIED" },
      });
      expect(denied).toMatchObject({ direction: "IN", overrideReason: null, scanKey: null });
      expect((await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).isInside).toBe(
        false,
      );
    });

    it("lets someone back in when the event allows re-entry", async () => {
      const p = await party();
      expect((await allowReentry(p)).json().event.reentryAllowed).toBe(true);
      const { code } = await p.comp("Ann");
      await p.scan(code);
      expect((await p.send(code, out)).json()).toEqual({
        outcome: "checked_out",
        ticket: ann,
        reentryAllowed: true,
      });
      expect((await p.scan(code)).json()).toEqual({ outcome: "admitted", ticket: ann });
      expect((await p.scan(code)).json().outcome).toBe("already_inside");
    });

    it("doesn't ask a returning attendee for their waiver again", async () => {
      const p = await waiverParty();
      await allowReentry(p);
      const { ticketId, code } = await p.comp("Ann");
      await p.send(code, { overrideReason: reason });
      await p.send(code, out);
      expect((await p.scan(code)).json().outcome).toBe("admitted");
      const scans = await t.prisma.scanEvent.findMany({
        where: { ticketId, direction: "IN" },
        orderBy: { createdAt: "asc" },
      });
      expect(scans).toMatchObject([
        { outcome: "WAIVER_MISSING", overrideReason: reason },
        { outcome: "ADMITTED", overrideReason: null },
      ]);
    });

    it("lets staff wave someone back in with a reason, kept on the scan", async () => {
      const p = await party();
      const { ticketId, code } = await p.comp("Ann");
      await p.scan(code);
      await p.send(code, out);
      const res = await p.send(code, { overrideReason: backIn, override: "reentry_denied" });
      expect(res.json()).toEqual({ outcome: "admitted", ticket: ann });
      const scan = await t.prisma.scanEvent.findFirstOrThrow({
        where: { ticketId, overrideReason: { not: null } },
      });
      expect(scan).toMatchObject({
        direction: "IN",
        outcome: "REENTRY_DENIED",
        overrideReason: backIn,
      });
      // The override counts as getting in, so the next scan says when it did.
      expect((await p.scan(code)).json()).toMatchObject({
        outcome: "already_inside",
        admittedAt: scan.scannedAt.toISOString(),
      });
    });

    it("won't let a waiver override wave someone back in", async () => {
      const p = await party();
      const { code } = await p.comp("Ann");
      await p.scan(code);
      await p.send(code, out);
      // Sent as older apps do, with no override named.
      expect((await p.send(code, { overrideReason: reason })).json().outcome).toBe(
        "reentry_denied",
      );
    });

    it("lets someone in plainly when re-entry was turned on after the override was asked", async () => {
      const p = await party();
      const { ticketId, code } = await p.comp("Ann");
      await p.scan(code);
      await p.send(code, out);
      await allowReentry(p);
      const res = await p.send(code, { overrideReason: backIn, override: "reentry_denied" });
      expect(res.json().outcome).toBe("admitted");
      const last = await t.prisma.scanEvent.findFirstOrThrow({
        where: { ticketId, direction: "IN" },
        orderBy: { createdAt: "desc" },
      });
      expect(last).toMatchObject({ outcome: "ADMITTED", overrideReason: null });
    });

    it("says someone who hasn't come in isn't inside", async () => {
      const p = await party();
      const { ticketId, code } = await p.comp("Ann");
      expect((await p.send(code, out)).json()).toEqual({
        outcome: "not_inside",
        ticket: ann,
        leftAt: null,
      });
      const scans = await t.prisma.scanEvent.findMany({ where: { ticketId } });
      expect(scans).toMatchObject([{ direction: "OUT", outcome: "NOT_INSIDE", scanKey: null }]);
    });

    it("says when someone checked out already, if they're scanned out twice", async () => {
      const p = await party();
      const { ticketId, code } = await p.comp("Ann");
      await p.scan(code);
      await p.send(code, out);
      const left = await t.prisma.scanEvent.findFirstOrThrow({
        where: { ticketId, outcome: "CHECKED_OUT" },
      });
      expect((await p.send(code, out)).json()).toEqual({
        outcome: "not_inside",
        ticket: ann,
        leftAt: left.scannedAt.toISOString(),
      });
    });

    it("lets only one of two devices checking out the same ticket at once record it", async () => {
      const p = await party();
      const { ticketId, code } = await p.comp("Ann");
      await p.scan(code);
      const results = await Promise.all([p.send(code, out), p.send(code, out), p.send(code, out)]);
      const outcomes = results.map((r) => r.json().outcome).sort();
      expect(outcomes).toEqual(["checked_out", "not_inside", "not_inside"]);
      expect(await t.prisma.scanEvent.count({ where: { ticketId, outcome: "CHECKED_OUT" } })).toBe(
        1,
      );
    });

    it("answers a retried check-out the same way when its first answer was lost", async () => {
      const p = await party();
      const { ticketId, code } = await p.comp("Ann");
      await p.scan(code);
      const scanKey = randomUUID();
      const first = (await p.send(code, { ...out, scanKey })).json();
      expect(first.outcome).toBe("checked_out");
      expect((await p.send(code, { ...out, scanKey })).json()).toEqual(first);
      expect(await t.prisma.scanEvent.count({ where: { ticketId, outcome: "CHECKED_OUT" } })).toBe(
        1,
      );
    });

    it("won't replay a check-out's key as a check-in, or an admission's as a check-out", async () => {
      const p = await party();
      const { code } = await p.comp("Ann");
      const inKey = randomUUID();
      await p.send(code, { scanKey: inKey });
      expect((await p.send(code, { ...out, scanKey: inKey })).statusCode).toBe(409);
      const outKey = randomUUID();
      await p.send(code, { ...out, scanKey: outKey });
      await allowReentry(p);
      // The key of the check-out can't let them back in; it was never an admission.
      expect((await p.send(code, { scanKey: outKey })).statusCode).toBe(409);
    });

    it("keeps out someone whose check-out lands while their check-in is deciding", async () => {
      const p = await party();
      const { ticketId, code } = await p.comp("Ann");
      await p.scan(code);
      let scanning: ReturnType<typeof p.scan> | undefined;
      // A check-out holds the ticket's row while it marks them out; a check-in that read them as
      // inside meanwhile must not then let them back in past the lock-in.
      await t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${ticketId}::uuid FOR UPDATE`;
        scanning = p.scan(code);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await tx.ticket.update({ where: { id: ticketId }, data: { isInside: false } });
        await tx.scanEvent.create({
          data: {
            eventId: p.prom.eventId,
            ticketId,
            direction: "OUT",
            outcome: "CHECKED_OUT",
            staffUserId: p.owner.userId,
            scannedAt: new Date(),
          },
        });
      });
      expect((await scanning!).json().outcome).toBe("reentry_denied");
      expect((await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).isInside).toBe(
        false,
      );
    });

    it("times a check-out that waited on a check-in after that check-in", async () => {
      const p = await party();
      await allowReentry(p);
      const { ticketId, code } = await p.comp("Ann");
      await p.scan(code);
      await p.send(code, out);
      let leaving: ReturnType<typeof p.send> | undefined;
      // The check-out starts first but gets the ticket only after a check-in that came later.
      await t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${ticketId}::uuid FOR UPDATE`;
        leaving = p.send(code, out);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await tx.ticket.update({ where: { id: ticketId }, data: { isInside: true } });
        await tx.scanEvent.create({
          data: {
            eventId: p.prom.eventId,
            ticketId,
            direction: "IN",
            outcome: "ADMITTED",
            staffUserId: p.owner.userId,
            scannedAt: new Date(),
          },
        });
      });
      expect((await leaving!).json().outcome).toBe("checked_out");
      const [last, before] = await t.prisma.scanEvent.findMany({
        where: { ticketId },
        orderBy: [{ scannedAt: "desc" }, { id: "desc" }],
        take: 2,
      });
      expect(last).toMatchObject({ direction: "OUT", outcome: "CHECKED_OUT" });
      expect(before).toMatchObject({ direction: "IN", outcome: "ADMITTED" });
    });

    it("replays a check-out retried after they came back in", async () => {
      const p = await party();
      await allowReentry(p);
      const { ticketId, code } = await p.comp("Ann");
      await p.scan(code);
      const scanKey = randomUUID();
      const first = (await p.send(code, { ...out, scanKey })).json();
      await p.scan(code);
      expect((await p.send(code, { ...out, scanKey })).json()).toEqual(first);
      // The retry changes nothing: they're still inside.
      expect((await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).isInside).toBe(
        true,
      );
    });

    it("replays an admission retried after they checked out", async () => {
      const p = await party();
      const { ticketId, code } = await p.comp("Ann");
      const scanKey = randomUUID();
      const first = (await p.send(code, { scanKey })).json();
      expect(first.outcome).toBe("admitted");
      await p.send(code, out);
      expect((await p.send(code, { scanKey })).json()).toEqual(first);
      expect((await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).isInside).toBe(
        false,
      );
      // With re-entry on, the retry still only replays rather than letting them in again.
      await allowReentry(p);
      expect((await p.send(code, { scanKey })).json()).toEqual(first);
      expect((await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).isInside).toBe(
        false,
      );
    });

    it("turns away a code that isn't a ticket on the way out too", async () => {
      const p = await party();
      expect((await p.send("nope", out)).json()).toEqual({
        outcome: "invalid_ticket",
        reason: "unknown",
      });
      const { orderId, code } = await p.comp("Bea");
      await p.call("POST", `${p.prom.base}/comps/${orderId}/void`);
      expect((await p.send(code, out)).json()).toEqual({
        outcome: "invalid_ticket",
        reason: "cancelled",
      });
    });
  });
});
