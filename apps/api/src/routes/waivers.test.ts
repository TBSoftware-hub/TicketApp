import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("waiver templates", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const draft = {
    title: "Field Trip Waiver",
    body: "I understand the risks of the trip.",
    requiresGuardianForMinors: true,
    fields: [
      { id: "allergy", label: "Allergies", type: "LONG_TEXT", required: false },
      { id: "size", label: "T-shirt size", type: "CHOICE", required: true, options: ["S", "M"] },
      { id: "photo", label: "You may take my photo", type: "CHECKBOX", required: false },
    ],
  };

  async function school() {
    const owner = await t.signIn();
    const org = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High School", slug: uniqueSlug("ths"), type: "SCHOOL" },
    });
    const orgId = org.json().organization.id as string;
    const call = (
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path = "",
      payload?: object,
      headers = owner.headers,
    ) => t.app.inject({ method, url: `/orgs/${orgId}/waivers${path}`, headers, payload });
    return { owner, orgId, call };
  }

  it("creates a waiver with its questions and lists it", async () => {
    const { call } = await school();
    const res = await call("POST", "", { ...draft, title: "  Field Trip Waiver " });
    expect(res.statusCode).toBe(201);
    const { waiver } = res.json();
    expect(waiver).toMatchObject({
      title: "Field Trip Waiver",
      version: 1,
      requiresGuardianForMinors: true,
      archivedAt: null,
      fieldCount: 3,
      eventCount: 0,
      signatureCount: 0,
      events: [],
    });
    expect(waiver.fields[0]).toEqual({ ...draft.fields[0], help: null });
    expect(waiver.fields[1].options).toEqual(["S", "M"]);

    const list = (await call("GET")).json().waivers;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: waiver.id, fieldCount: 3 });
    expect(list[0].body).toBeUndefined();
    expect((await call("GET", `/${waiver.id}`)).json().waiver.body).toBe(draft.body);

    const versions = await t.prisma.waiverTemplateVersion.findMany({
      where: { waiverTemplateId: waiver.id },
    });
    expect(versions).toMatchObject([{ version: 1, title: "Field Trip Waiver", body: draft.body }]);
  });

  it("keeps every version of the wording, and only counts real changes", async () => {
    const { call } = await school();
    const { waiver } = (await call("POST", "", draft)).json();
    const same = await call("PUT", `/${waiver.id}`, { ...draft, version: 1 });
    expect(same.statusCode).toBe(200);
    expect(same.json().waiver.version).toBe(1);

    const edited = await call("PUT", `/${waiver.id}`, {
      ...draft,
      body: "I understand the risks of the trip and the bus ride.",
      version: 1,
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().waiver.version).toBe(2);
    const reworded = await call("PUT", `/${waiver.id}`, {
      ...draft,
      fields: draft.fields.slice(1),
      version: 2,
    });
    expect(reworded.json().waiver).toMatchObject({ version: 3, fieldCount: 2 });

    const versions = await t.prisma.waiverTemplateVersion.findMany({
      where: { waiverTemplateId: waiver.id },
      orderBy: { version: "asc" },
    });
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions[0]!.body).toBe(draft.body);
    expect(versions[1]!.body).toMatch(/bus ride/);
    expect(versions[2]!.fields).toHaveLength(2);
  });

  it("won't let a save from an old version overwrite a newer one", async () => {
    const { call } = await school();
    const { waiver } = (await call("POST", "", draft)).json();
    await call("PUT", `/${waiver.id}`, { ...draft, title: "Trip Waiver", version: 1 });
    const stale = await call("PUT", `/${waiver.id}`, { ...draft, title: "Old Trip", version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatch(/Someone else saved/);
    expect((await call("GET", `/${waiver.id}`)).json().waiver.title).toBe("Trip Waiver");
  });

  it("archives and restores, and deletes only what nothing uses", async () => {
    const { owner, orgId, call } = await school();
    const { waiver } = (await call("POST", "", draft)).json();
    const archived = await call("PATCH", `/${waiver.id}`, { archived: true });
    expect(archived.json().waiver.archivedAt).not.toBeNull();
    const restored = await call("PATCH", `/${waiver.id}`, { archived: false });
    expect(restored.json().waiver.archivedAt).toBeNull();

    const event = await t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/events`,
      headers: owner.headers,
      payload: {
        name: "Museum Trip",
        slug: uniqueSlug("trip"),
        startsAt: "2099-05-01T15:00:00.000Z",
        endsAt: "2099-05-01T21:00:00.000Z",
      },
    });
    const eventId = event.json().event.id as string;
    const ticketType = await t.prisma.ticketType.create({
      data: { eventId, name: "Student", priceCents: 0 },
    });
    await t.prisma.ticketTypeWaiver.create({
      data: { ticketTypeId: ticketType.id, waiverTemplateId: waiver.id },
    });
    const used = (await call("GET", `/${waiver.id}`)).json().waiver;
    expect(used).toMatchObject({
      eventCount: 1,
      events: [{ id: eventId, name: "Museum Trip", ticketTypes: ["Student"] }],
    });
    const refused = await call("DELETE", `/${waiver.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("Tickets use this waiver, so archive it instead");

    const spare = (await call("POST", "", draft)).json().waiver;
    expect((await call("DELETE", `/${spare.id}`)).statusCode).toBe(204);
    expect((await call("GET", `/${spare.id}`)).statusCode).toBe(404);
    expect(
      await t.prisma.waiverTemplateVersion.count({ where: { waiverTemplateId: spare.id } }),
    ).toBe(0);
  });

  it("is only for people who manage events in the organization", async () => {
    const { call } = await school();
    const { waiver } = (await call("POST", "", draft)).json();
    const stranger = await t.signIn();
    expect((await call("GET", "", undefined, stranger.headers)).statusCode).toBe(404);
    expect(
      (await call("PUT", `/${waiver.id}`, { ...draft, version: 1 }, stranger.headers)).statusCode,
    ).toBe(404);

    // Another organization's owner can't reach it through their own organization either.
    const other = await school();
    expect((await other.call("GET", `/${waiver.id}`)).statusCode).toBe(404);
    expect((await other.call("PATCH", `/${waiver.id}`, { archived: true })).statusCode).toBe(404);
    expect((await other.call("DELETE", `/${waiver.id}`)).statusCode).toBe(404);
    expect((await other.call("GET", `/${randomUUID()}`)).statusCode).toBe(404);
  });

  it("checks the form", async () => {
    const { call } = await school();
    expect((await call("POST", "", { ...draft, title: "" })).statusCode).toBe(400);
    const oneChoice = { id: "x", label: "Pick", type: "CHOICE", required: true, options: ["A"] };
    expect((await call("POST", "", { ...draft, fields: [oneChoice] })).statusCode).toBe(400);
    const twice = [draft.fields[0], draft.fields[0]];
    expect((await call("POST", "", { ...draft, fields: twice })).statusCode).toBe(400);
    const { waiver } = (await call("POST", "", draft)).json();
    expect((await call("PUT", `/${waiver.id}`, draft)).statusCode).toBe(400);
  });
});
