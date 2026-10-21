import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonical } from "../lib/canonical";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("waivers on ticket types", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const tripWaiver = {
    title: "Field Trip Waiver",
    body: "I understand the risks of the trip.",
    requiresGuardianForMinors: true,
    fields: [
      { id: "allergy", label: "Allergies", type: "TEXT", required: false },
      { id: "size", label: "T-shirt size", type: "CHOICE", required: true, options: ["S", "M"] },
      { id: "rules", label: "I'll follow the rules", type: "CHECKBOX", required: true },
    ],
  };

  /** A published event with free tickets, so checkout needs no payment. */
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
        startsAt: "2099-05-01T15:00:00.000Z",
        endsAt: "2099-05-01T21:00:00.000Z",
      },
    });
    const eventId = event.json().event.id as string;
    const base = `/orgs/${orgId}/events/${eventId}`;
    const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: owner.headers, payload });
    const newWaiver = async (payload: object = tripWaiver) =>
      (await call("POST", `/orgs/${orgId}/waivers`, payload)).json().waiver as {
        id: string;
        version: number;
      };
    const addTicket = (payload: Record<string, unknown> = {}) =>
      call("POST", `${base}/ticket-types`, {
        name: "Student",
        priceCents: 0,
        maxPerOrder: 4,
        ...payload,
      });
    const publish = () => call("POST", `${base}/status`, { status: "PUBLISHED" });
    const checkout = (tickets: object[]) =>
      t.app.inject({
        method: "POST",
        url: `/public/events/${orgSlug}/${eventSlug}/checkout`,
        headers: { "user-agent": "Test Browser" },
        payload: { buyerName: "Pat Parent", buyerEmail: "pat@example.com", tickets },
      });
    return { orgId, orgSlug, eventSlug, base, call, newWaiver, addTicket, publish, checkout };
  }

  const signed = (waiver: { id: string; version: number }, extra: object = {}) => ({
    waiverId: waiver.id,
    version: waiver.version,
    answers: { size: "M", rules: true },
    signature: "Jo Park",
    agreed: true,
    ...extra,
  });

  it("attaches waivers to a ticket type and shows them to buyers", async () => {
    const s = await trip();
    const waiver = await s.newWaiver();
    const res = await s.addTicket({ waiverIds: [waiver.id.toUpperCase()] });
    expect(res.statusCode).toBe(201);
    expect(res.json().ticketType.waiverIds).toEqual([waiver.id]);
    await s.addTicket({ name: "Chaperone" });
    await s.publish();

    const page = (
      await t.app.inject({ method: "GET", url: `/public/events/${s.orgSlug}/${s.eventSlug}` })
    ).json();
    expect(page.ticketTypes.map((tt: { waiverIds: string[] }) => tt.waiverIds)).toEqual([
      [waiver.id],
      [],
    ]);
    expect(page.waivers).toEqual([
      {
        id: waiver.id,
        version: 1,
        title: tripWaiver.title,
        body: tripWaiver.body,
        requiresGuardianForMinors: true,
        fields: expect.arrayContaining([expect.objectContaining({ id: "size" })]),
      },
    ]);
  });

  it("records each attendee's signature and answers with the order", async () => {
    const s = await trip();
    const waiver = await s.newWaiver();
    const ticketTypeId = (await s.addTicket({ waiverIds: [waiver.id] })).json().ticketType.id;
    await s.publish();
    const res = await s.checkout([
      {
        ticketTypeId,
        firstName: "Jo",
        lastName: "Park",
        waivers: [signed(waiver, { answers: { allergy: " peanuts ", size: "M", rules: true } })],
      },
      {
        ticketTypeId,
        firstName: "Sam",
        lastName: "Lee",
        waivers: [signed(waiver, { signature: "sam lee" })],
      },
    ]);
    expect(res.statusCode).toBe(201);

    const signatures = await t.prisma.waiverSignature.findMany({
      where: { ticket: { orderId: res.json().orderId } },
      orderBy: { signerName: "asc" },
    });
    const version = await t.prisma.waiverTemplateVersion.findUniqueOrThrow({
      where: { waiverTemplateId_version: { waiverTemplateId: waiver.id, version: 1 } },
    });
    const hash = createHash("sha256")
      .update(canonical({ title: version.title, body: version.body, fields: version.fields }))
      .digest("hex");
    expect(signatures).toMatchObject([
      {
        waiverTemplateId: waiver.id,
        templateVersion: 1,
        signerRole: "ATTENDEE",
        signerName: "Jo Park",
        answers: { allergy: "peanuts", size: "M", rules: true },
        userAgent: "Test Browser",
        documentHash: hash,
      },
      { signerName: "Sam Lee", answers: { size: "M", rules: true } },
    ]);
    expect(signatures[0]!.ipAddress).toBeTruthy();
  });

  it("refuses a checkout with a waiver missing, unsigned or half answered", async () => {
    const s = await trip();
    const waiver = await s.newWaiver();
    const other = await s.newWaiver({ ...tripWaiver, title: "Photo Release", fields: [] });
    const ticketTypeId = (await s.addTicket({ waiverIds: [waiver.id] })).json().ticketType.id;
    await s.publish();
    const attempt = async (waivers: object[]) => {
      const res = await s.checkout([{ ticketTypeId, firstName: "Jo", lastName: "Park", waivers }]);
      return [res.statusCode, res.json().error];
    };

    expect(await attempt([])).toEqual([400, "Sign each waiver for Jo"]);
    expect(await attempt([signed(waiver), signed(waiver)])).toEqual([
      400,
      "Sign each waiver for Jo",
    ]);
    expect(await attempt([signed(other)])).toEqual([400, "Sign each waiver for Jo"]);
    expect(await attempt([signed(waiver), signed(other)])).toEqual([
      400,
      "Sign each waiver for Jo",
    ]);
    expect(await attempt([signed(waiver, { signature: "Pat Parent" })])).toEqual([
      400,
      "Sign “Field Trip Waiver” by typing Jo Park",
    ]);
    expect(await attempt([signed(waiver, { answers: { rules: true } })])).toEqual([
      400,
      "Answer “T-shirt size” in “Field Trip Waiver” (Jo)",
    ]);
    expect((await attempt([signed(waiver, { agreed: false })]))[0]).toBe(400);
    expect(await t.prisma.waiverSignature.count({ where: { waiverTemplateId: waiver.id } })).toBe(
      0,
    );
  });

  it("refuses a signature on wording that changed since the page loaded", async () => {
    const s = await trip();
    const waiver = await s.newWaiver();
    const ticketTypeId = (await s.addTicket({ waiverIds: [waiver.id] })).json().ticketType.id;
    await s.publish();
    await s.call("PUT", `/orgs/${s.orgId}/waivers/${waiver.id}`, {
      ...tripWaiver,
      body: "New wording.",
      version: 1,
    });
    const stale = await s.checkout([
      { ticketTypeId, firstName: "Jo", lastName: "Park", waivers: [signed(waiver)] },
    ]);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe(
      "“Field Trip Waiver” was just updated. Reload the page to read the new version",
    );
    const fresh = await s.checkout([
      {
        ticketTypeId,
        firstName: "Jo",
        lastName: "Park",
        waivers: [signed({ id: waiver.id, version: 2 })],
      },
    ]);
    expect(fresh.statusCode).toBe(201);
  });

  it("changes a ticket type's waivers, keeping archived ones only where they already were", async () => {
    const s = await trip();
    const kept = await s.newWaiver();
    const old = await s.newWaiver({ ...tripWaiver, title: "Old Waiver" });
    const res = await s.addTicket({ waiverIds: [kept.id, old.id] });
    const ticketTypeId = res.json().ticketType.id as string;
    const url = `${s.base}/ticket-types/${ticketTypeId}`;
    await s.call("PATCH", `/orgs/${s.orgId}/waivers/${old.id}`, { archived: true });

    // Saving the ticket with its archived waiver still on it is fine.
    const same = await s.call("PATCH", url, { waiverIds: [kept.id, old.id] });
    expect(same.statusCode).toBe(200);
    expect(same.json().ticketType.waiverIds.sort()).toEqual([kept.id, old.id].sort());

    const dropped = await s.call("PATCH", url, { waiverIds: [kept.id] });
    expect(dropped.json().ticketType.waiverIds).toEqual([kept.id]);
    const readded = await s.call("PATCH", url, { waiverIds: [kept.id, old.id] });
    expect(readded.statusCode).toBe(400);
    expect(readded.json().error).toBe(
      "That waiver is archived. Restore it before adding it to tickets",
    );
    const fresh = await s.addTicket({ name: "Guest", waiverIds: [old.id] });
    expect(fresh.statusCode).toBe(400);

    // Leaving waiverIds out leaves them alone; an empty list clears them.
    expect((await s.call("PATCH", url, { name: "Students" })).json().ticketType.waiverIds).toEqual([
      kept.id,
    ]);
    expect((await s.call("PATCH", url, { waiverIds: [] })).json().ticketType.waiverIds).toEqual([]);

    // Another organization's waiver can't be borrowed.
    const elsewhere = await trip();
    const theirs = await elsewhere.newWaiver();
    const borrowed = await s.call("PATCH", url, { waiverIds: [theirs.id] });
    expect(borrowed.statusCode).toBe(400);
    expect(borrowed.json().error).toBe("Pick waivers from this organization");
  });

  it("lists the events and ticket types using a waiver", async () => {
    const s = await trip();
    const waiver = await s.newWaiver();
    await s.addTicket({ waiverIds: [waiver.id] });
    await s.addTicket({ name: "Chaperone", waiverIds: [waiver.id] });
    const res = (await s.call("GET", `/orgs/${s.orgId}/waivers/${waiver.id}`)).json().waiver;
    expect(res.eventCount).toBe(1);
    expect(res.events).toMatchObject([
      { name: "Museum Trip", ticketTypes: ["Student", "Chaperone"] },
    ]);
  });
});
