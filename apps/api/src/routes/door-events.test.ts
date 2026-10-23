import type { EventStatus, Role } from "@ticketapp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("door app event picker", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const HOUR = 60 * 60 * 1000;

  async function orgWith(userId: string, role: Role, name = "Lincoln High PTA") {
    return t.prisma.organization.create({
      data: {
        name,
        slug: uniqueSlug("door"),
        type: "COMMITTEE",
        memberships: { create: { userId, role } },
      },
    });
  }

  function event(
    organizationId: string,
    name: string,
    {
      startsIn = HOUR,
      lasts = 4 * HOUR,
      status = "PUBLISHED",
    }: { startsIn?: number; lasts?: number; status?: EventStatus } = {},
  ) {
    const startsAt = new Date(Date.now() + startsIn);
    return t.prisma.event.create({
      data: {
        organizationId,
        name,
        slug: uniqueSlug("event"),
        startsAt,
        endsAt: new Date(startsAt.getTime() + lasts),
        status,
      },
    });
  }

  it("lists published events that haven't ended, soonest first, with their organization", async () => {
    const staff = await t.signIn();
    const org = await orgWith(staff.userId, "DOOR_STAFF");
    const later = await event(org.id, "Spring Formal", { startsIn: 30 * 24 * HOUR });
    const tonight = await event(org.id, "After-prom", { startsIn: -HOUR });
    await event(org.id, "Last year's prom", { startsIn: -10 * HOUR });
    await t.prisma.event.update({ where: { id: later.id }, data: { venue: "Main Gym" } });

    const res = await t.app.inject({ method: "GET", url: "/door/events", headers: staff.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([
      {
        id: tonight.id,
        name: "After-prom",
        venue: null,
        startsAt: tonight.startsAt.toISOString(),
        endsAt: tonight.endsAt.toISOString(),
        organization: { id: org.id, name: "Lincoln High PTA", timezone: "America/New_York" },
      },
      expect.objectContaining({ id: later.id, name: "Spring Formal", venue: "Main Gym" }),
    ]);
  });

  it("leaves out drafts and cancelled events", async () => {
    const staff = await t.signIn();
    const org = await orgWith(staff.userId, "OWNER");
    await event(org.id, "Draft", { status: "DRAFT" });
    await event(org.id, "Cancelled", { status: "CANCELLED" });

    const res = await t.app.inject({ method: "GET", url: "/door/events", headers: staff.headers });
    expect(res.json().events).toEqual([]);
  });

  it("only shows organizations where the staff member's role can scan", async () => {
    const staff = await t.signIn();
    const viewing = await orgWith(staff.userId, "VIEWER", "Viewer org");
    const scanning = await orgWith(staff.userId, "ADMIN", "Admin org");
    await event(viewing.id, "Not mine to scan");
    const mine = await event(scanning.id, "Mine to scan");

    const res = await t.app.inject({ method: "GET", url: "/door/events", headers: staff.headers });
    expect(res.json().events.map((e: { id: string }) => e.id)).toEqual([mine.id]);
  });

  it("doesn't show other organizations' events", async () => {
    const owner = await t.signIn();
    const outsider = await t.signIn();
    const org = await orgWith(owner.userId, "OWNER");
    await event(org.id, "Private");

    const res = await t.app.inject({
      method: "GET",
      url: "/door/events",
      headers: outsider.headers,
    });
    expect(res.json().events).toEqual([]);
  });

  it("requires sign-in", async () => {
    expect((await t.app.inject({ method: "GET", url: "/door/events" })).statusCode).toBe(401);
  });
});
