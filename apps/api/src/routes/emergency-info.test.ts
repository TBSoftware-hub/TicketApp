import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("emergency contact and medical notes", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  /** A published event with a free ticket that asks for emergency info, and one that doesn't. */
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
    const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: owner.headers, payload });
    const addTicket = async (payload: Record<string, unknown>) =>
      (
        await call("POST", `${base}/ticket-types`, {
          priceCents: 0,
          maxPerOrder: 4,
          ...payload,
        })
      ).json().ticketType as { id: string; askEmergencyInfo: boolean };
    const student = await addTicket({ name: "Student", askEmergencyInfo: true });
    const guest = await addTicket({ name: "Guest" });
    await call("POST", `${base}/status`, { status: "PUBLISHED" });
    const checkout = (tickets: object[]) =>
      t.app.inject({
        method: "POST",
        url: `/public/events/${orgSlug}/${eventSlug}/checkout`,
        payload: { buyerName: "Pat Parent", buyerEmail: "pat@example.com", tickets },
      });
    return { orgSlug, eventSlug, base, call, student, guest, checkout };
  }

  const emergency = {
    contactName: "Pat Parent",
    contactPhone: "(555) 201-3344",
    medicalNotes: "  Peanut allergy, carries an EpiPen ",
  };

  it("asks for it on the ticket types that want it, and shows it to staff", async () => {
    const s = await trip();
    expect(s.student.askEmergencyInfo).toBe(true);
    expect(s.guest.askEmergencyInfo).toBe(false);
    const page = (
      await t.app.inject({ method: "GET", url: `/public/events/${s.orgSlug}/${s.eventSlug}` })
    ).json() as { ticketTypes: { name: string; askEmergencyInfo: boolean }[] };
    expect(page.ticketTypes.map((tt) => [tt.name, tt.askEmergencyInfo])).toEqual([
      ["Student", true],
      ["Guest", false],
    ]);

    const res = await s.checkout([
      { ticketTypeId: s.student.id, firstName: "Jo", lastName: "Park", emergency },
      // Given for a ticket that doesn't ask, so it isn't kept.
      { ticketTypeId: s.guest.id, firstName: "Sam", lastName: "Park", emergency },
    ]);
    expect(res.statusCode).toBe(201);

    const { orders } = (await s.call("GET", `${s.base}/orders`)).json() as {
      orders: { tickets: { attendee: Record<string, string | null> }[] }[];
    };
    const attendees = orders[0]!.tickets
      .map((tk) => tk.attendee)
      .sort((a, b) => a.firstName!.localeCompare(b.firstName!));
    expect(attendees).toEqual([
      {
        firstName: "Jo",
        lastName: "Park",
        emergencyContactName: "Pat Parent",
        emergencyContactPhone: "+15552013344",
        medicalNotes: "Peanut allergy, carries an EpiPen",
      },
      {
        firstName: "Sam",
        lastName: "Park",
        emergencyContactName: null,
        emergencyContactPhone: null,
        medicalNotes: null,
      },
    ]);

    // The buyer's own order page doesn't repeat it.
    const { orderId, key } = res.json() as { orderId: string; key: string };
    const order = await t.app.inject({
      method: "POST",
      url: `/public/orders/${orderId}`,
      payload: { key },
    });
    expect(order.body).not.toContain("Peanut");
    expect(order.body).not.toContain("2013344");
  });

  it("needs a contact name and phone, but not medical notes", async () => {
    const s = await trip();
    const buy = (extra: object) =>
      s.checkout([{ ticketTypeId: s.student.id, firstName: "Jo", lastName: "Park", ...extra }]);

    const none = await buy({});
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toBe("Give an emergency contact for Jo");

    const badPhone = await buy({ emergency: { ...emergency, contactPhone: "12" } });
    expect(badPhone.statusCode).toBe(400);
    expect(badPhone.json().error).toContain("Enter a valid phone number for the emergency contact");

    const noName = await buy({ emergency: { ...emergency, contactName: " " } });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error).toContain("Enter the emergency contact's name");

    const tooLong = await buy({ emergency: { ...emergency, medicalNotes: "x".repeat(2001) } });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toContain("Keep medical notes under 2000 characters");

    const noNotes = await buy({ emergency: { ...emergency, medicalNotes: "" } });
    expect(noNotes.statusCode).toBe(201);
    const { orders } = (await s.call("GET", `${s.base}/orders`)).json() as {
      orders: { tickets: { attendee: Record<string, string | null> }[] }[];
    };
    expect(orders[0]!.tickets[0]!.attendee).toMatchObject({
      emergencyContactName: "Pat Parent",
      medicalNotes: null,
    });
  });

  it("ignores anything sent for a ticket type that doesn't ask, even if it wouldn't pass", async () => {
    const s = await trip();
    const res = await s.checkout([
      {
        ticketTypeId: s.guest.id,
        firstName: "Sam",
        lastName: "Park",
        emergency: { contactName: "", contactPhone: "" },
      },
    ]);
    expect(res.statusCode).toBe(201);
    const { orders } = (await s.call("GET", `${s.base}/orders`)).json() as {
      orders: { tickets: { attendee: Record<string, string | null> }[] }[];
    };
    expect(orders[0]!.tickets[0]!.attendee).toMatchObject({
      emergencyContactName: null,
      emergencyContactPhone: null,
    });
  });

  it("can be turned on and off for a ticket type", async () => {
    const s = await trip();
    const url = `${s.base}/ticket-types/${s.guest.id}`;
    const on = await s.call("PATCH", url, { askEmergencyInfo: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().ticketType.askEmergencyInfo).toBe(true);
    const buy = await s.checkout([{ ticketTypeId: s.guest.id, firstName: "Sam", lastName: "P" }]);
    expect(buy.statusCode).toBe(400);
    const off = await s.call("PATCH", url, { askEmergencyInfo: false });
    expect(off.json().ticketType.askEmergencyInfo).toBe(false);
  });
});
