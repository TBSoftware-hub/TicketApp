import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("publishing and the public event page", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  async function draftEvent(overrides: Record<string, unknown> = {}) {
    const owner = await t.signIn();
    const orgSlug = uniqueSlug("ths");
    const org = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High School", slug: orgSlug, type: "SCHOOL" },
    });
    const orgId = org.json().organization.id as string;
    const eventSlug = uniqueSlug("prom");
    const event = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: {
        name: "After Prom",
        slug: eventSlug,
        venue: "Rec Center",
        startsAt: "2099-05-01T03:00:00.000Z",
        endsAt: "2099-05-01T09:00:00.000Z",
        capacity: 300,
        ...overrides,
      },
    });
    const eventId = event.json().event.id as string;
    const base = `/orgs/${orgId}/events/${eventId}`;
    const setStatus = (status: string) =>
      t.app.inject({
        method: "POST",
        url: `${base}/status`,
        headers: owner.headers,
        payload: { status },
      });
    const addTicket = (payload: Record<string, unknown> = {}) =>
      t.app.inject({
        method: "POST",
        url: `${base}/ticket-types`,
        headers: owner.headers,
        payload: { name: "Student", priceCents: 3000, maxPerOrder: 2, ...payload },
      });
    const publicUrl = `/public/events/${orgSlug}/${eventSlug}`;
    return { owner, orgId, eventId, setStatus, addTicket, publicUrl };
  }

  it("hides drafts from the public", async () => {
    const { publicUrl, addTicket } = await draftEvent();
    await addTicket();
    expect((await t.app.inject({ method: "GET", url: publicUrl })).statusCode).toBe(404);
  });

  it("won't publish an event with no tickets", async () => {
    const { setStatus } = await draftEvent();
    const res = await setStatus("PUBLISHED");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/ticket type/);
  });

  it("won't publish an event that has ended", async () => {
    const { setStatus, addTicket } = await draftEvent({
      startsAt: "2020-05-01T03:00:00.000Z",
      endsAt: "2020-05-01T09:00:00.000Z",
    });
    await addTicket();
    expect((await setStatus("PUBLISHED")).statusCode).toBe(409);
  });

  it("shows a published event without signing in, without counts", async () => {
    const { setStatus, addTicket, publicUrl } = await draftEvent();
    await addTicket({ quantity: 200, studentsOnly: true, minGrade: 11, maxGrade: 12 });
    await addTicket({
      name: "Guest pass",
      requiresApproval: true,
      salesStartAt: "2099-04-01T00:00:00.000Z",
    });
    expect((await setStatus("PUBLISHED")).json().event.status).toBe("PUBLISHED");

    const res = await t.app.inject({ method: "GET", url: publicUrl });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.event).toMatchObject({
      name: "After Prom",
      venue: "Rec Center",
      status: "PUBLISHED",
      organizationName: "Test High School",
      timezone: "America/New_York",
    });
    expect(body.event).not.toHaveProperty("capacity");
    expect(body.ticketTypes).toEqual([
      expect.objectContaining({ name: "Student", minGrade: 11, saleStatus: "onSale" }),
      expect.objectContaining({
        name: "Guest pass",
        requiresApproval: true,
        saleStatus: "upcoming",
      }),
    ]);
    expect(body.ticketTypes[0]).not.toHaveProperty("quantity");
    expect(body.ticketTypes[0]).not.toHaveProperty("_count");
  });

  it("keeps a cancelled event visible with nothing on sale, and hides it again as a draft", async () => {
    const { setStatus, addTicket, publicUrl } = await draftEvent();
    await addTicket();
    await setStatus("PUBLISHED");
    await setStatus("CANCELLED");
    const res = await t.app.inject({ method: "GET", url: publicUrl });
    expect(res.json().event.status).toBe("CANCELLED");
    expect(res.json().ticketTypes[0].saleStatus).toBe("ended");

    await setStatus("DRAFT");
    expect((await t.app.inject({ method: "GET", url: publicUrl })).statusCode).toBe(404);
  });

  it("only lets event managers change the status", async () => {
    const { orgId, eventId } = await draftEvent();
    const stranger = await t.signIn();
    const res = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events/${eventId}/status`,
      headers: stranger.headers,
      payload: { status: "PUBLISHED" },
    });
    expect(res.statusCode).toBe(404);
  });
});
