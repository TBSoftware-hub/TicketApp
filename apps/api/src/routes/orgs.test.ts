import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("organizations and roles", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  async function createOrg(headers: Record<string, string>) {
    const res = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers,
      payload: { name: "Lincoln High After-Prom", slug: uniqueSlug("lincoln"), type: "COMMITTEE" },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ organization: { id: string; slug: string } }>().organization;
  }

  it("makes the creator the owner", async () => {
    const owner = await t.signIn();
    const org = await createOrg(owner.headers);

    const me = await t.app.inject({ method: "GET", url: "/me", headers: owner.headers });
    expect(me.json().memberships).toEqual([
      expect.objectContaining({
        role: "OWNER",
        organization: expect.objectContaining({ id: org.id }),
      }),
    ]);
  });

  it("refuses a slug that is already taken", async () => {
    const owner = await t.signIn();
    const org = await createOrg(owner.headers);
    const res = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Copycat", slug: org.slug, type: "SCHOOL" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("hides organizations from non-members", async () => {
    const owner = await t.signIn();
    const org = await createOrg(owner.headers);
    const outsider = await t.signIn();
    const res = await t.app.inject({
      method: "GET",
      url: `/orgs/${org.id}`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("lets door staff view the organization but not change its settings", async () => {
    const owner = await t.signIn();
    const org = await createOrg(owner.headers);
    const door = await t.signIn();
    await t.prisma.membership.create({
      data: { userId: door.userId, organizationId: org.id, role: "DOOR_STAFF" },
    });

    const view = await t.app.inject({
      method: "GET",
      url: `/orgs/${org.id}`,
      headers: door.headers,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().role).toBe("DOOR_STAFF");

    const edit = await t.app.inject({
      method: "PATCH",
      url: `/orgs/${org.id}`,
      headers: door.headers,
      payload: { name: "Renamed" },
    });
    expect(edit.statusCode).toBe(403);

    const ownerEdit = await t.app.inject({
      method: "PATCH",
      url: `/orgs/${org.id}`,
      headers: owner.headers,
      payload: { name: "Lincoln High PTO" },
    });
    expect(ownerEdit.statusCode).toBe(200);
    expect(ownerEdit.json().organization.name).toBe("Lincoln High PTO");
  });
});
