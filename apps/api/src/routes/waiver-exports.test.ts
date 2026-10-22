import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, parseCsv, pdfText, uniqueSlug } from "../test-helpers";

describe("waiver exports for vendors", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  // A month away, so the minor's date of birth is in the past.
  const startsAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
  const minor = `${startsAt.getUTCFullYear() - 10}-06-01`;

  /**
   * An event with three attendees on a waiver ticket: an adult who signed, a minor waiting on
   * their guardian, and a comp nobody signed for. Plus a guest on a ticket with no waiver.
   */
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
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 6 * 60 * 60_000).toISOString(),
      },
    });
    const base = `/orgs/${orgId}/events/${event.json().event.id}`;
    const call = (method: "GET" | "POST", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: owner.headers, payload });
    const waiver = (
      await call("POST", `/orgs/${orgId}/waivers`, {
        title: "Field Trip Waiver",
        body: "I understand the risks of the trip.",
        requiresGuardianForMinors: true,
        fields: [{ id: "allergy", label: "Allergies", type: "TEXT", required: false }],
      })
    ).json().waiver as { id: string; version: number };
    const student = (
      await call("POST", `${base}/ticket-types`, {
        name: "Student",
        priceCents: 0,
        maxPerOrder: 4,
        waiverIds: [waiver.id],
        askEmergencyInfo: true,
      })
    ).json().ticketType.id as string;
    const guest = (
      await call("POST", `${base}/ticket-types`, { name: "Guest", priceCents: 0, maxPerOrder: 4 })
    ).json().ticketType.id as string;
    await call("POST", `${base}/status`, { status: "PUBLISHED" });

    const signed = (signature: string) => [
      {
        waiverId: waiver.id,
        version: waiver.version,
        answers: { allergy: "Shellfish" },
        signature,
        agreed: true,
      },
    ];
    const emergency = {
      contactName: "Pat Parent",
      contactPhone: "555 201 3344",
      medicalNotes: '=HYPERLINK("x"), "peanuts"',
    };
    const res = await t.app.inject({
      method: "POST",
      url: `/public/events/${orgSlug}/${eventSlug}/checkout`,
      payload: {
        buyerName: "Pat Parent",
        buyerEmail: "pat@example.com",
        tickets: [
          {
            ticketTypeId: student,
            firstName: "Ann",
            lastName: "Adams",
            dateOfBirth: "1990-01-01",
            waivers: signed("Ann Adams"),
            emergency,
          },
          {
            ticketTypeId: student,
            firstName: "Jo",
            lastName: "Park",
            dateOfBirth: minor,
            guardian: { name: "Sam Park", email: "sam@example.com" },
            waivers: signed("Jo Park"),
            emergency,
          },
          { ticketTypeId: guest, firstName: "Gus", lastName: "Guest" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const comp = await call("POST", `${base}/comps`, {
      ticketTypeId: student,
      firstName: "Cal",
      lastName: "Comp",
      email: "cal@example.com",
    });
    expect(comp.statusCode).toBe(201);
    return { orgId, base, owner, call };
  }

  it("lists each attendee's waiver status as a CSV", async () => {
    const s = await trip();
    const res = await s.call("GET", `${s.base}/waivers.csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="trip-.*-waivers\.csv"$/,
    );
    expect(res.body.startsWith("\uFEFF")).toBe(true);

    const [header, ...rows] = parseCsv(res.body.slice(1));
    const col = (name: string) => header!.indexOf(name);
    expect(header).not.toContain("Medical notes");
    // Sorted by last name; the guest's ticket has no waiver, so they aren't listed.
    expect(rows.map((r) => r[col("Last name")])).toEqual(["Adams", "Comp", "Park"]);
    const [ann, cal, jo] = rows as [string[], string[], string[]];
    expect(ann[col("Waiver status")]).toBe("Signed");
    expect(ann[col("Waivers signed")]).toBe("Field Trip Waiver (v1)");
    expect(ann[col("Attendee signed at")]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(cal[col("Waiver status")]).toBe("Not signed");
    expect(jo[col("Waiver status")]).toBe("Waiting on Sam Park to sign");
    expect(jo[col("Parent or guardian")]).toBe("Sam Park");
    expect(jo[col("Guardian contact")]).toBe("sam@example.com");
    expect(jo[col("Date of birth")]).toBe(minor);

    // Emergency contacts and medical notes only when asked for, with formulas defused.
    const full = await s.call("GET", `${s.base}/waivers.csv?details=1`);
    expect(full.headers["content-disposition"]).toContain("waivers-with-medical.csv");
    const [h2, first] = parseCsv(full.body.slice(1));
    expect(first![h2!.indexOf("Emergency phone")]).toBe("(555) 201-3344");
    expect(first![h2!.indexOf("Medical notes")]).toBe(`'=HYPERLINK("x"), "peanuts"`);
  });

  it("tells the orders page what there is to download", async () => {
    const s = await trip();
    const res = (await s.call("GET", `${s.base}/orders`)).json();
    expect(res.waiverTickets).toBe(3);
    expect(res.signedWaiverTickets).toBe(2);
  });

  it("puts every signed waiver in one PDF, after a cover page", async () => {
    const s = await trip();
    const res = await s.call("GET", `${s.base}/waivers.pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    const text = pdfText(res.rawPayload);
    // The cover lists everyone with a waiver, then each signed ticket follows.
    expect(text).toContain("Museum Trip");
    expect(text).toContain("3 attendees · 2 with signed waivers in this file");
    expect(text).toContain("Comp, Cal · Student");
    expect(text).toContain("Not signed");
    expect(text).toContain("Waiting on Sam Park to sign");
    expect(text).toContain("Signed by Ann Adams (attendee)");
    expect(text).toContain("Signed by Jo Park (attendee)");
    expect(text).not.toContain("Gus");
    // Medical notes, and answers to the waiver's questions, stay out of the PDF.
    expect(text).not.toContain("peanuts");
    expect(text).not.toContain("Shellfish");
    expect(text).toContain("1 answer left out of this copy, since they can include medical");
  });

  it("credits the guardian by the name they signed with", async () => {
    const s = await trip();
    const mail = t.sent.findLast((m) => m.to === "sam@example.com")!;
    const token = new URL(mail.text.match(/https:\S+/)![0]).searchParams.get("token")!;
    const signed = await t.app.inject({
      method: "POST",
      url: "/public/guardian-signatures/sign",
      payload: { token, signature: "Samantha Park", agreed: true },
    });
    expect(signed.statusCode).toBe(200);

    const [header, ...rows] = parseCsv(
      (await s.call("GET", `${s.base}/waivers.csv`)).body.slice(1),
    );
    const jo = rows.find((r) => r[header!.indexOf("First name")] === "Jo")!;
    expect(jo[header!.indexOf("Waiver status")]).toBe(
      "Signed, with Samantha Park as parent or guardian",
    );
    expect(jo[header!.indexOf("Parent or guardian")]).toBe("Samantha Park");
    expect(jo[header!.indexOf("Guardian signed at")]).not.toBe("");
    const text = pdfText((await s.call("GET", `${s.base}/waivers.pdf`)).rawPayload);
    expect(text).toContain("Signed, with Samantha Park as parent or guardian");
  });

  it("is for staff who manage the event", async () => {
    const s = await trip();
    const stranger = await t.signIn();
    for (const path of ["waivers.csv", "waivers.pdf"]) {
      const res = await t.app.inject({
        method: "GET",
        url: `${s.base}/${path}`,
        headers: stranger.headers,
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("says so when nobody has signed yet", async () => {
    const s = await trip();
    const empty = await s.call("POST", `/orgs/${s.orgId}/events`, {
      name: "Quiet Trip",
      slug: uniqueSlug("quiet"),
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
    });
    const base = `/orgs/${s.orgId}/events/${empty.json().event.id}`;
    const pdf = await s.call("GET", `${base}/waivers.pdf`);
    expect(pdf.statusCode).toBe(404);
    expect(pdf.json().error).toBe("Nobody has signed a waiver for this event yet");
    // The CSV still downloads, with just its header.
    const csv = await s.call("GET", `${base}/waivers.csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});
