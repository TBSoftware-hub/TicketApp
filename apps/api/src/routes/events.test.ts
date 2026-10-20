import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("events", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  async function ownerWithOrg() {
    const owner = await t.signIn();
    const res = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High School", slug: uniqueSlug("ths"), type: "SCHOOL" },
    });
    return { owner, orgId: res.json<{ organization: { id: string } }>().organization.id };
  }

  async function memberWithRole(
    owner: { headers: Record<string, string> },
    orgId: string,
    role: string,
  ) {
    const email = `m-${randomUUID()}@example.com`;
    await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/invitations`,
      headers: owner.headers,
      payload: { email, role },
    });
    const token = new URL(
      t.sent.findLast((m) => m.to === email)!.text.match(/https:\S+/)![0],
    ).searchParams.get("token");
    const res = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token },
    });
    return { authorization: `Bearer ${res.json().sessionToken}` };
  }

  const homecoming = () => ({
    name: "Homecoming Dance",
    slug: uniqueSlug("homecoming"),
    venue: "Main Gym",
    description: "Semi-formal. Doors open at 7.",
    startsAt: "2026-11-15T00:00:00.000Z",
    endsAt: "2026-11-15T03:00:00.000Z",
    capacity: 400,
  });

  it("creates an event as a draft and lists it", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const input = homecoming();
    const res = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: input,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().event).toMatchObject({ ...input, status: "DRAFT" });

    const list = await t.app.inject({
      method: "GET",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
    });
    expect(list.json().events).toEqual([expect.objectContaining({ slug: input.slug })]);
  });

  it("edits an event", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: homecoming(),
    });
    const { id } = created.json().event;

    const res = await t.app.inject({
      method: "PATCH",
      url: `/orgs/${orgId}/events/${id}`,
      headers: owner.headers,
      payload: { venue: "Auditorium", capacity: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toMatchObject({
      venue: "Auditorium",
      capacity: null,
      name: "Homecoming Dance",
    });

    const got = await t.app.inject({
      method: "GET",
      url: `/orgs/${orgId}/events/${id}`,
      headers: owner.headers,
    });
    expect(got.json().event.venue).toBe("Auditorium");
  });

  it("requires the event to end after it starts", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const bad = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: { ...homecoming(), endsAt: "2026-11-14T23:00:00.000Z" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("end after it starts");

    const created = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: homecoming(),
    });
    const patch = await t.app.inject({
      method: "PATCH",
      url: `/orgs/${orgId}/events/${created.json().event.id}`,
      headers: owner.headers,
      payload: { startsAt: "2026-11-16T00:00:00.000Z" },
    });
    expect(patch.statusCode).toBe(400);
  });

  it("keeps the event valid when both ends are edited at the same moment", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: homecoming(),
    });
    const id = created.json().event.id;
    // Each change is fine alone; together they would end the event before it starts.
    const results = await Promise.all([
      t.app.inject({
        method: "PATCH",
        url: `/orgs/${orgId}/events/${id}`,
        headers: owner.headers,
        payload: { startsAt: "2026-11-15T02:00:00.000Z" },
      }),
      t.app.inject({
        method: "PATCH",
        url: `/orgs/${orgId}/events/${id}`,
        headers: owner.headers,
        payload: { endsAt: "2026-11-15T01:00:00.000Z" },
      }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    const row = await t.prisma.event.findUniqueOrThrow({ where: { id } });
    expect(row.endsAt > row.startsAt).toBe(true);
  });

  it("refuses a web address another event in the organization uses", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const input = homecoming();
    await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: input,
    });
    const dup = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: input,
    });
    expect(dup.statusCode).toBe(409);
  });

  it("lets admins manage events, door staff only see them, and outsiders nothing", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const admin = await memberWithRole(owner, orgId, "ADMIN");
    const door = await memberWithRole(owner, orgId, "DOOR_STAFF");
    const stranger = await t.signIn();

    const byAdmin = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: admin,
      payload: homecoming(),
    });
    expect(byAdmin.statusCode).toBe(201);
    const byDoor = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: door,
      payload: homecoming(),
    });
    expect(byDoor.statusCode).toBe(403);
    const doorList = await t.app.inject({
      method: "GET",
      url: `/orgs/${orgId}/events`,
      headers: door,
    });
    expect(doorList.json().events).toHaveLength(1);
    const strangerList = await t.app.inject({
      method: "GET",
      url: `/orgs/${orgId}/events`,
      headers: stranger.headers,
    });
    expect(strangerList.statusCode).toBe(404);
  });

  it("doesn't show or edit another organization's event", async () => {
    const a = await ownerWithOrg();
    const b = await ownerWithOrg();
    const created = await t.app.inject({
      method: "POST",
      url: `/orgs/${a.orgId}/events`,
      headers: a.owner.headers,
      payload: homecoming(),
    });
    const id = created.json().event.id;
    const got = await t.app.inject({
      method: "GET",
      url: `/orgs/${b.orgId}/events/${id}`,
      headers: b.owner.headers,
    });
    expect(got.statusCode).toBe(404);
    const patched = await t.app.inject({
      method: "PATCH",
      url: `/orgs/${b.orgId}/events/${id}`,
      headers: b.owner.headers,
      payload: { name: "Hijacked" },
    });
    expect(patched.statusCode).toBe(404);
  });
});
