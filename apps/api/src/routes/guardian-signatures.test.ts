import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDate } from "@ticketapp/shared";
import { canonical } from "../lib/canonical";
import type { TextMessage } from "../lib/texter";
import { generateToken } from "../lib/tokens";
import { buildTestApp, pdfText, uniqueSlug } from "../test-helpers";

describe("guardian signatures for minors", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;
  const texts: TextMessage[] = [];

  beforeAll(async () => {
    t = await buildTestApp({ texter: { send: async (m) => void texts.push(m) } });
  });

  afterAll(async () => {
    await t.close();
  });

  const tripWaiver = {
    title: "Field Trip Waiver",
    body: "I understand the risks of the trip.",
    requiresGuardianForMinors: true,
    fields: [
      { id: "size", label: "T-shirt size", type: "CHOICE", required: true, options: ["S", "M"] },
    ],
  };

  // A month away, so the dates of birth below are in the past.
  const startsAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
  const endsAt = new Date(startsAt.getTime() + 6 * 60 * 60_000);
  const minor = `${startsAt.getUTCFullYear() - 10}-06-01`;

  /** A published event with a free ticket that asks for the waiver. */
  async function trip(waiver: object = tripWaiver) {
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
        endsAt: endsAt.toISOString(),
      },
    });
    const base = `/orgs/${orgId}/events/${event.json().event.id}`;
    const call = (method: "POST" | "PUT", url: string, payload: object) =>
      t.app.inject({ method, url, headers: owner.headers, payload });
    const created = (await call("POST", `/orgs/${orgId}/waivers`, waiver)).json().waiver as {
      id: string;
      version: number;
    };
    const ticketTypeId = (
      await call("POST", `${base}/ticket-types`, {
        name: "Student",
        priceCents: 0,
        maxPerOrder: 4,
        waiverIds: [created.id],
      })
    ).json().ticketType.id as string;
    await call("POST", `${base}/status`, { status: "PUBLISHED" });
    const checkout = (tickets: object[], buyerEmail = "pat@example.com") =>
      t.app.inject({
        method: "POST",
        url: `/public/events/${orgSlug}/${eventSlug}/checkout`,
        payload: { buyerName: "Pat Parent", buyerEmail, tickets },
      });
    const attendee = (extra: object = {}) => ({
      ticketTypeId,
      firstName: "Jo",
      lastName: "Park",
      waivers: [
        {
          waiverId: created.id,
          version: created.version,
          answers: { size: "M" },
          signature: "Jo Park",
          agreed: true,
        },
      ],
      ...extra,
    });
    const timezone = org.json().organization.timezone as string;
    return { orgId, base, owner, timezone, waiver: created, call, checkout, attendee };
  }

  /** The signing link's token, from the last message sent to `to`. */
  function tokenSentTo(to: string) {
    const mail = t.sent.findLast((m) => m.to === to);
    const text = texts.findLast((m) => m.to === to);
    const body = mail?.text ?? text?.body ?? "";
    return new URL(body.match(/https:\S+/)![0]).searchParams.get("token")!;
  }

  const view = (token: string) =>
    t.app.inject({ method: "POST", url: "/public/guardian-signatures/view", payload: { token } });
  const sign = (token: string, payload: object = {}) =>
    t.app.inject({
      method: "POST",
      url: "/public/guardian-signatures/sign",
      headers: { "user-agent": "Guardian Browser" },
      payload: { token, signature: "Sam Park", agreed: true, ...payload },
    });

  it("asks for a date of birth, and a guardian only for minors", async () => {
    const s = await trip();
    const attempt = async (extra: object) => {
      const res = await s.checkout([s.attendee(extra)]);
      return [res.statusCode, res.json().error];
    };
    expect(await attempt({})).toEqual([400, "Enter Jo's date of birth"]);
    expect(await attempt({ dateOfBirth: minor })).toEqual([
      400,
      "Jo is under 18, so give a parent or guardian to sign for them",
    ]);
    expect(
      await attempt({ dateOfBirth: minor, guardian: { name: "Sam Park", email: "" } }),
    ).toEqual([400, "tickets.0.guardian: Give the parent or guardian's email or mobile number"]);

    // 18 on the day of the event: no guardian needed, and none recorded.
    const day = localDate(startsAt, s.timezone);
    const eighteen = `${Number(day.slice(0, 4)) - 18}${day.slice(4)}`;
    const adult = await s.checkout([s.attendee({ dateOfBirth: eighteen })]);
    expect(adult.statusCode).toBe(201);
    const ticket = await t.prisma.ticket.findFirstOrThrow({
      where: { orderId: adult.json().orderId },
      select: { guardianRequest: true, attendee: { select: { dateOfBirth: true } } },
    });
    expect(ticket.guardianRequest).toBeNull();
    expect(ticket.attendee.dateOfBirth?.toISOString().slice(0, 10)).toBe(eighteen);
  });

  it("doesn't ask about age when no waiver needs a guardian", async () => {
    const s = await trip({ ...tripWaiver, requiresGuardianForMinors: false });
    const res = await s.checkout([s.attendee()]);
    expect(res.statusCode).toBe(201);
  });

  it("sends the guardian a link by email and text, and records their signature", async () => {
    const s = await trip();
    const res = await s.checkout([
      s.attendee({
        dateOfBirth: minor,
        guardian: { name: "Sam Park", email: "sam@example.com", phone: "(555) 201-3344" },
      }),
    ]);
    expect(res.statusCode).toBe(201);

    const mail = t.sent.findLast((m) => m.to === "sam@example.com")!;
    expect(mail.subject).toBe("Please sign for Jo to go to Museum Trip");
    expect(mail.text).toContain("Pat Parent got a ticket for Jo Park to Museum Trip");
    expect(texts.findLast((m) => m.to === "+15552013344")?.body).toContain(
      "please sign here: https://dashboard.test/sign?token=",
    );
    const token = tokenSentTo("sam@example.com");
    expect(tokenSentTo("+15552013344")).toBe(token);

    const request = await t.prisma.guardianSignatureRequest.findFirstOrThrow({
      where: { ticket: { orderId: res.json().orderId } },
    });
    expect(request).toMatchObject({ pendingMessages: null, signedAt: null });
    expect(request.emailSentAt).not.toBeNull();
    expect(request.textSentAt).not.toBeNull();
    const log = await t.prisma.notification.findMany({
      where: { guardianId: request.guardianId },
      orderBy: { channel: "asc" },
    });
    expect(log.map((n) => [n.channel, n.to, n.status])).toEqual([
      ["SMS", "+15552013344", "SENT"],
      ["EMAIL", "sam@example.com", "SENT"],
    ]);
    // The log keeps what was asked, never the working link.
    expect(log.every((n) => !n.body.includes("token"))).toBe(true);

    const shown = (await view(token)).json().request;
    expect(shown).toMatchObject({
      guardianName: "Sam Park",
      buyerName: "Pat Parent",
      attendee: { firstName: "Jo", lastName: "Park" },
      event: { name: "Museum Trip", organizationName: "Test High School" },
      waivers: [
        { id: s.waiver.id, version: 1, title: "Field Trip Waiver", answers: { size: "M" } },
      ],
      signedAt: null,
    });

    expect((await sign(token, { agreed: false })).statusCode).toBe(400);
    expect((await sign(token, { signature: " " })).json().error).toBe(
      "signature: Type your full name to sign",
    );
    const signed = await sign(token);
    expect(signed.statusCode).toBe(200);
    expect(signed.json().request).toMatchObject({ signerName: "Sam Park" });
    expect(signed.json().request.signedAt).not.toBeNull();

    const version = await t.prisma.waiverTemplateVersion.findUniqueOrThrow({
      where: { waiverTemplateId_version: { waiverTemplateId: s.waiver.id, version: 1 } },
    });
    const hash = createHash("sha256")
      .update(canonical({ title: version.title, body: version.body, fields: version.fields }))
      .digest("hex");
    const signature = await t.prisma.waiverSignature.findFirstOrThrow({
      where: { ticketId: request.ticketId, signerRole: "GUARDIAN" },
    });
    expect(signature).toMatchObject({
      waiverTemplateId: s.waiver.id,
      templateVersion: 1,
      signerName: "Sam Park",
      guardianId: request.guardianId,
      userAgent: "Guardian Browser",
      documentHash: hash,
    });

    const again = await sign(token);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("These waivers are already signed");
  });

  it("has the guardian sign the version the attendee signed, even after a change", async () => {
    const s = await trip();
    const res = await s.checkout([
      s.attendee({
        dateOfBirth: minor,
        guardian: { name: "Sam", email: "sam2@example.com" },
      }),
    ]);
    const token = tokenSentTo("sam2@example.com");
    await s.call("PUT", `/orgs/${s.orgId}/waivers/${s.waiver.id}`, {
      ...tripWaiver,
      body: "New wording.",
      version: 1,
    });
    expect((await view(token)).json().request.waivers).toMatchObject([
      { version: 1, body: tripWaiver.body },
    ]);
    expect((await sign(token)).statusCode).toBe(200);
    const signature = await t.prisma.waiverSignature.findFirstOrThrow({
      where: { ticket: { orderId: res.json().orderId }, signerRole: "GUARDIAN" },
    });
    expect(signature.templateVersion).toBe(1);
  });

  it("tells a parent buying for their child that it's their own order", async () => {
    const s = await trip();
    await s.checkout(
      [
        s.attendee({
          dateOfBirth: minor,
          guardian: { name: "Pat", email: "pat3@example.com" },
        }),
      ],
      "pat3@example.com",
    );
    const mails = t.sent.filter((m) => m.to === "pat3@example.com");
    expect(mails.map((m) => m.subject)).toContain("Please sign for Jo to go to Museum Trip");
    expect(mails.find((m) => m.subject.startsWith("Please sign"))!.text).toContain(
      "You got a ticket for Jo Park",
    );
  });

  it("retries a link that couldn't be sent", async () => {
    const s = await trip();
    t.mailFailures.to.add("sam4@example.com");
    const res = await s.checkout([
      s.attendee({
        dateOfBirth: minor,
        guardian: { name: "Sam", email: "sam4@example.com" },
      }),
    ]);
    t.mailFailures.to.delete("sam4@example.com");
    expect(res.statusCode).toBe(201);
    const { orderId, key } = res.json();
    const where = { ticket: { orderId } };
    expect(await t.prisma.guardianSignatureRequest.findFirstOrThrow({ where })).toMatchObject({
      emailSentAt: null,
      sendAttempts: 1,
      sendClaimedAt: null,
    });

    // The buyer coming back to their order tries again.
    await t.app.inject({ method: "POST", url: `/public/orders/${orderId}`, payload: { key } });
    const request = await t.prisma.guardianSignatureRequest.findFirstOrThrow({ where });
    expect(request.emailSentAt).not.toBeNull();
    expect(request.pendingMessages).toBeNull();
    const mail = t.sent.findLast((m) => m.to === "sam4@example.com")!;
    expect(mail.idempotencyKey).toBe(`guardian-request-${request.id}`);
    expect((await view(tokenSentTo("sam4@example.com"))).statusCode).toBe(200);
  });

  it("shuts the link, and stops sending it, once the event is over", async () => {
    const s = await trip();
    t.mailFailures.to.add("sam6@example.com");
    const res = await s.checkout([
      s.attendee({ dateOfBirth: minor, guardian: { name: "Sam", email: "sam6@example.com" } }),
    ]);
    t.mailFailures.to.delete("sam6@example.com");
    const { orderId, key } = res.json();
    const ticket = await t.prisma.ticket.findFirstOrThrow({ where: { orderId } });
    await t.prisma.event.update({
      where: { id: ticket.eventId },
      data: { startsAt: new Date(Date.now() - 2 * 60 * 60_000), endsAt: new Date(Date.now() - 1) },
    });

    // The unsent link isn't sent now that it couldn't be used.
    await t.app.inject({ method: "POST", url: `/public/orders/${orderId}`, payload: { key } });
    const request = await t.prisma.guardianSignatureRequest.findFirstOrThrow({
      where: { ticketId: ticket.id },
    });
    expect(request).toMatchObject({ emailSentAt: null, sendAttempts: 1 });
    expect(t.sent.some((m) => m.to === "sam6@example.com")).toBe(false);

    // A link sent earlier shows nothing about the attendee any more.
    const token = generateToken();
    await t.prisma.guardianSignatureRequest.update({
      where: { id: request.id },
      data: { tokenHash: createHash("sha256").update(token).digest("hex") },
    });
    const shown = await view(token);
    expect(shown.statusCode).toBe(410);
    expect(shown.json()).toEqual({ error: "Museum Trip is over, so this link no longer works" });
    expect((await sign(token)).statusCode).toBe(410);
  });

  it("shuts the link, and stops sending it, when the event is cancelled", async () => {
    const s = await trip();
    t.mailFailures.to.add("sam7@example.com");
    const res = await s.checkout([
      s.attendee({ dateOfBirth: minor, guardian: { name: "Sam", email: "sam7@example.com" } }),
    ]);
    t.mailFailures.to.delete("sam7@example.com");
    const { orderId, key } = res.json();
    const ticket = await t.prisma.ticket.findFirstOrThrow({ where: { orderId } });
    await t.prisma.event.update({ where: { id: ticket.eventId }, data: { status: "CANCELLED" } });

    await t.app.inject({ method: "POST", url: `/public/orders/${orderId}`, payload: { key } });
    expect(t.sent.some((m) => m.to === "sam7@example.com")).toBe(false);

    const token = generateToken();
    await t.prisma.guardianSignatureRequest.updateMany({
      where: { ticketId: ticket.id },
      data: { tokenHash: createHash("sha256").update(token).digest("hex") },
    });
    const shown = await view(token);
    expect(shown.statusCode).toBe(410);
    expect(shown.json().error).toBe("Museum Trip was cancelled, so this link no longer works");
    expect((await sign(token)).statusCode).toBe(410);
  });

  it("holds off cancelling an order while a guardian's link is going out", async () => {
    const s = await trip();
    const res = await s.checkout([
      s.attendee({ dateOfBirth: minor, guardian: { name: "Sam", email: "sam8@example.com" } }),
    ]);
    const { orderId } = res.json();
    const ticket = await t.prisma.ticket.findFirstOrThrow({ where: { orderId } });
    await t.prisma.guardianSignatureRequest.updateMany({
      where: { ticketId: ticket.id },
      data: { sendClaimedAt: new Date() },
    });
    const url = `/orgs/${s.orgId}/events/${ticket.eventId}/orders/${orderId}/cancel`;
    const busy = await s.call("POST", url, {});
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe(
      "A guardian's signing link for this order is going out right now. Try again in a minute.",
    );
    await t.prisma.guardianSignatureRequest.updateMany({
      where: { ticketId: ticket.id },
      data: { sendClaimedAt: null },
    });
    expect((await s.call("POST", url, {})).statusCode).toBe(200);
  });

  it("gives staff, the buyer and the guardian the signed waivers as a PDF", async () => {
    const s = await trip();
    const res = await s.checkout([
      s.attendee({
        dateOfBirth: minor,
        guardian: { name: "Sam Park", email: "sam@example.com" },
      }),
    ]);
    const { orderId, key } = res.json() as { orderId: string; key: string };
    const token = tokenSentTo("sam@example.com");
    await sign(token);
    const ticket = await t.prisma.ticket.findFirstOrThrow({ where: { orderId } });

    const staffUrl = `${s.base}/tickets/${ticket.id}/waivers.pdf`;
    const staff = await t.app.inject({ method: "GET", url: staffUrl, headers: s.owner.headers });
    expect(staff.statusCode).toBe(200);
    expect(staff.headers["content-type"]).toBe("application/pdf");
    expect(staff.headers["content-disposition"]).toBe('attachment; filename="Jo-Park-waivers.pdf"');
    const text = await pdfText(staff.rawPayload);
    for (const expected of [
      "Signed waivers",
      "Jo Park · Student",
      "Field Trip Waiver",
      "I understand the risks of the trip.",
      "T-shirt size: M",
      "Signed by Jo Park (attendee)",
      "Signed by Sam Park (parent or guardian)",
      "Audit trail",
      "Browser: Guardian Browser",
      "Link sent to: sam@example.com",
      "Wording check: matches the stored waiver",
    ]) {
      expect(text).toContain(expected);
    }
    const signatures = await t.prisma.waiverSignature.findMany({ where: { ticketId: ticket.id } });
    for (const sig of signatures) expect(text).toContain(`Signature ID: ${sig.id}`);

    const buyerUrl = `/public/orders/${orderId}/tickets/${ticket.id}/waivers.pdf`;
    const buyer = await t.app.inject({ method: "POST", url: buyerUrl, payload: { key } });
    expect(buyer.statusCode).toBe(200);
    expect(await pdfText(buyer.rawPayload)).toContain("Signed by Sam Park (parent or guardian)");
    const guardian = await t.app.inject({
      method: "POST",
      url: "/public/guardian-signatures/waivers.pdf",
      payload: { token },
    });
    expect(guardian.statusCode).toBe(200);

    // Only with the order's own key, or as staff of the event's organization.
    expect(
      (await t.app.inject({ method: "POST", url: buyerUrl, payload: { key: "wrong" } })).statusCode,
    ).toBe(404);
    const stranger = await t.signIn();
    expect(
      (await t.app.inject({ method: "GET", url: staffUrl, headers: stranger.headers })).statusCode,
    ).toBe(404);

    // Wording changed behind the app's back shows up as a mismatch.
    await t.prisma.waiverTemplateVersion.update({
      where: { waiverTemplateId_version: { waiverTemplateId: s.waiver.id, version: 1 } },
      data: { body: "I waive everything." },
    });
    const tampered = await t.app.inject({ method: "GET", url: staffUrl, headers: s.owner.headers });
    expect(await pdfText(tampered.rawPayload)).toContain(
      "Wording check: DOES NOT MATCH the stored waiver",
    );
  });

  it("refuses a link that doesn't match a paid ticket", async () => {
    expect((await view("not-a-real-token")).statusCode).toBe(404);
    expect((await sign("not-a-real-token")).statusCode).toBe(404);
  });
});
