import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("student roster", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const ROSTER = [
    "Student ID,First Name,Last Name,Grade",
    "S-100,Sam,O'Brien,11",
    "S-200,Jo,Park,9",
    "S-300,Al,Ng,",
  ].join("\n");

  /** A school with a free students-only prom for grades 11 and 12, and an open dance. */
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
    const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: owner.headers, payload });
    const startsAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    const eventSlug = uniqueSlug("prom");
    const event = await call("POST", `/orgs/${orgId}/events`, {
      name: "Prom",
      slug: eventSlug,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 4 * 60 * 60_000).toISOString(),
    });
    const base = `/orgs/${orgId}/events/${event.json().event.id}`;
    const type = async (payload: object) =>
      (
        await call("POST", `${base}/ticket-types`, { priceCents: 0, maxPerOrder: 4, ...payload })
      ).json().ticketType.id as string;
    const prom = await type({ name: "Prom", studentsOnly: true, minGrade: 11, maxGrade: 12 });
    const dance = await type({ name: "Dance", studentsOnly: true });
    const guest = await type({ name: "Guest" });
    await call("POST", `${base}/status`, { status: "PUBLISHED" });
    const buy = (tickets: object[]) =>
      t.app.inject({
        method: "POST",
        url: `/public/events/${orgSlug}/${eventSlug}/checkout`,
        payload: { buyerName: "Pat Parent", buyerEmail: "pat@example.com", tickets },
      });
    return { orgId, orgSlug, eventSlug, base, call, buy, prom, dance, guest };
  }

  it("imports a CSV, replacing the last one, and only shows counts", async () => {
    const s = await school();
    expect((await s.call("GET", `/orgs/${s.orgId}/roster`)).json()).toEqual({ roster: null });

    const res = await s.call("PUT", `/orgs/${s.orgId}/roster`, { csv: ROSTER });
    expect(res.statusCode).toBe(200);
    const { roster } = res.json();
    expect(roster.students).toBe(3);
    expect(roster.grades).toEqual([
      { grade: 9, students: 1 },
      { grade: 11, students: 1 },
      { grade: null, students: 1 },
    ]);
    expect(JSON.stringify(roster)).not.toContain("Park");

    const again = await s.call("PUT", `/orgs/${s.orgId}/roster`, {
      csv: "id,first,last\nS-900,Lu,Wong\n",
    });
    expect(again.json().roster.students).toBe(1);
  });

  it("imports nothing when any row is bad", async () => {
    const s = await school();
    await s.call("PUT", `/orgs/${s.orgId}/roster`, { csv: ROSTER });
    const res = await s.call("PUT", `/orgs/${s.orgId}/roster`, {
      csv: `${ROSTER}\nS-100,Dup,Lee,10\nS-400,Ki,Ho,14`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Nothing was imported. Fix these rows and try again",
      problems: [
        "Line 5: student ID S-100 is also on line 2",
        'Line 6: "14" isn\'t a grade from 1 to 12',
      ],
    });
    // The roster from before is untouched.
    expect((await s.call("GET", `/orgs/${s.orgId}/roster`)).json().roster.students).toBe(3);
  });

  it("matches students-only tickets against the roster at checkout", async () => {
    const s = await school();
    await s.call("PUT", `/orgs/${s.orgId}/roster`, { csv: ROSTER });
    const pub = await t.app.inject({
      method: "GET",
      url: `/public/events/${s.orgSlug}/${s.eventSlug}`,
    });
    expect(pub.json().event.studentRoster).toBe(true);

    const fail = async (ticket: object) => {
      const res = await s.buy([ticket]);
      expect(res.statusCode).toBe(400);
      return res.json().error as string;
    };
    const sam = { ticketTypeId: s.prom, firstName: "Sam", lastName: "obrien" };
    expect(await fail(sam)).toBe("Enter Sam's student ID");
    expect(await fail({ ...sam, studentId: "S-999" })).toBe(
      "The school's roster doesn't have student ID S-999 with the last name obrien. Check both and try again",
    );
    // Someone else's ID with the wrong last name doesn't get through.
    expect(await fail({ ...sam, studentId: "S-200" })).toContain("doesn't have student ID S-200");
    // The roster's grade counts, whatever the buyer picked.
    expect(
      await fail({ ...sam, firstName: "Jo", lastName: "Park", studentId: "s-200", grade: 12 }),
    ).toBe("These tickets are for grades 11–12 (Jo)");
    expect(await fail({ ...sam, firstName: "Al", lastName: "Ng", studentId: "S-300" })).toBe(
      "The school's roster doesn't list Al's grade, so ask the school to add it",
    );
    const twice = await s.buy([
      { ...sam, studentId: "S-100" },
      { ...sam, studentId: "s-100 " },
    ]);
    expect(twice.json().error).toBe("Student ID S-100 is on more than one Prom ticket");

    const ok = await s.buy([
      { ...sam, studentId: " s-100" },
      // No grade limit, so a student with no grade on file is fine.
      { ticketTypeId: s.dance, firstName: "Al", lastName: "NG", studentId: "S-300" },
      // Tickets anyone can buy don't ask.
      { ticketTypeId: s.guest, firstName: "Gus", lastName: "Guest" },
    ]);
    expect(ok.statusCode).toBe(201);
    const attendees = await t.prisma.attendee.findMany({
      where: { tickets: { some: { orderId: ok.json().orderId } } },
      orderBy: { firstName: "asc" },
      select: { firstName: true, studentId: true, grade: true },
    });
    expect(attendees).toEqual([
      { firstName: "Al", studentId: "S-300", grade: null },
      { firstName: "Gus", studentId: null, grade: null },
      { firstName: "Sam", studentId: "S-100", grade: 11 },
    ]);

    // One ticket of each type per student, across orders, until the first is cancelled.
    const again = await s.buy([{ ...sam, studentId: "S-100" }]);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("Student ID S-100 already has a Prom ticket");
    // A different ticket type is fine.
    expect((await s.buy([{ ...sam, ticketTypeId: s.dance, studentId: "S-100" }])).statusCode).toBe(
      201,
    );
    const cancel = await s.call("POST", `${s.base}/orders/${ok.json().orderId}/cancel`);
    expect(cancel.statusCode).toBe(200);
    expect((await s.buy([{ ...sam, studentId: "S-100" }])).statusCode).toBe(201);
  });

  it("goes back to the buyer's word once the roster is removed", async () => {
    const s = await school();
    await s.call("PUT", `/orgs/${s.orgId}/roster`, { csv: ROSTER });
    expect((await s.call("DELETE", `/orgs/${s.orgId}/roster`)).statusCode).toBe(204);
    expect((await s.call("GET", `/orgs/${s.orgId}/roster`)).json()).toEqual({ roster: null });
    expect(await t.prisma.rosterStudent.count({ where: { organizationId: s.orgId } })).toBe(0);

    const res = await s.buy([
      { ticketTypeId: s.prom, firstName: "Kim", lastName: "Lee", grade: 12, studentId: "X" },
    ]);
    expect(res.statusCode).toBe(201);
    const pub = await t.app.inject({
      method: "GET",
      url: `/public/events/${s.orgSlug}/${s.eventSlug}`,
    });
    expect(pub.json().event.studentRoster).toBe(false);
  });

  it("is for staff who manage events", async () => {
    const s = await school();
    const member = async (role: string) => {
      const email = `m-${randomUUID()}@example.com`;
      await s.call("POST", `/orgs/${s.orgId}/invitations`, { email, role });
      const token = new URL(
        t.sent.findLast((m) => m.to === email)!.text.match(/https:\S+/)![0],
      ).searchParams.get("token");
      const res = await t.app.inject({
        method: "POST",
        url: "/invitations/accept",
        payload: { token },
      });
      return { authorization: `Bearer ${res.json().sessionToken}` };
    };
    const as = (headers: Record<string, string>, method: "GET" | "PUT" = "GET") =>
      t.app.inject({
        method,
        url: `/orgs/${s.orgId}/roster`,
        headers,
        payload: method === "PUT" ? { csv: ROSTER } : undefined,
      });
    expect((await as(await member("ADMIN"), "PUT")).statusCode).toBe(200);
    expect((await as(await member("DOOR_STAFF"))).statusCode).toBe(403);
    expect((await as(await member("VIEWER"))).statusCode).toBe(403);
    expect((await as((await t.signIn()).headers)).statusCode).toBe(404);
  });
});
