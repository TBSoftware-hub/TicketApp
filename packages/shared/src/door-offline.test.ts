import { describe, expect, it } from "vitest";
import {
  afterScan,
  decideOffline,
  DOOR_LOOKUP_LIMIT,
  doorListSchema,
  searchDoorList,
  type DoorListTicket,
} from "./index";

const ticket = (fields: Partial<DoorListTicket> = {}): DoorListTicket => ({
  ticketId: "01a1562f-061b-72dd-a3fe-40770af4ed8f",
  firstName: "Ann",
  lastName: "Lee",
  attendeeName: "Ann Lee",
  ticketTypeName: "Guest",
  grade: 12,
  codeHash: "a".repeat(64),
  checkIn: "not-arrived",
  waiver: "signed",
  leftAt: null,
  ...fields,
});
const ann = { attendeeName: "Ann Lee", ticketTypeName: "Guest" };
const leftAt = new Date("2026-05-02T23:00:00Z");

describe("decideOffline", () => {
  it("lets in someone who hasn't arrived, and keeps the scan to send", () => {
    expect(decideOffline(ticket(), { direction: "in" }, false)).toEqual({
      result: { outcome: "admitted", ticket: ann },
      moves: true,
    });
    expect(decideOffline(ticket({ waiver: "none" }), { direction: "in" }, false).moves).toBe(true);
  });

  it("says someone inside is already in, without keeping the scan", () => {
    expect(decideOffline(ticket({ checkIn: "inside" }), { direction: "in" }, false)).toEqual({
      result: { outcome: "already_inside", ticket: ann, admittedAt: null },
      moves: false,
    });
  });

  it("holds up a missing waiver unless staff override it", () => {
    expect(decideOffline(ticket({ waiver: "missing" }), { direction: "in" }, false)).toEqual({
      result: { outcome: "waiver_missing", ticket: ann, reason: "not_signed" },
      moves: false,
    });
    expect(
      decideOffline(ticket({ waiver: "waiting" }), { direction: "in" }, false).result,
    ).toMatchObject({ reason: "guardian_pending" });
    const overridden = {
      direction: "in",
      override: "waiver_missing",
      overrideReason: "Paper",
    } as const;
    expect(decideOffline(ticket({ waiver: "missing" }), overridden, false)).toEqual({
      result: { outcome: "admitted", ticket: ann },
      moves: true,
    });
    // An override for the other answer doesn't lift this one.
    expect(
      decideOffline(
        ticket({ waiver: "missing" }),
        { direction: "in", override: "reentry_denied", overrideReason: "Paper" },
        false,
      ).result.outcome,
    ).toBe("waiver_missing");
  });

  it("keeps out someone who left when the event has no re-entry, unless overridden", () => {
    const left = ticket({ checkIn: "left", leftAt, waiver: "missing" });
    expect(decideOffline(left, { direction: "in" }, false)).toEqual({
      result: { outcome: "reentry_denied", ticket: ann, leftAt },
      moves: false,
    });
    // Coming back in isn't held up by the waiver again.
    expect(decideOffline(left, { direction: "in" }, true).result.outcome).toBe("admitted");
    expect(
      decideOffline(
        left,
        { direction: "in", override: "reentry_denied", overrideReason: "Chaperone" },
        false,
      ).result.outcome,
    ).toBe("admitted");
  });

  it("checks out someone inside, and says when someone isn't", () => {
    expect(decideOffline(ticket({ checkIn: "inside" }), { direction: "out" }, true)).toEqual({
      result: { outcome: "checked_out", ticket: ann, reentryAllowed: true },
      moves: true,
    });
    expect(decideOffline(ticket({ checkIn: "left", leftAt }), { direction: "out" }, false)).toEqual(
      { result: { outcome: "not_inside", ticket: ann, leftAt }, moves: false },
    );
  });
});

describe("afterScan", () => {
  const at = new Date("2026-05-03T01:00:00Z");

  it("moves the saved ticket in or out to match the answer", () => {
    expect(afterScan(ticket(), { outcome: "admitted", ticket: ann }, at)?.checkIn).toBe("inside");
    expect(
      afterScan(
        ticket({ checkIn: "inside" }),
        { outcome: "checked_out", ticket: ann, reentryAllowed: false },
        at,
      ),
    ).toMatchObject({ checkIn: "left", leftAt: at });
  });

  it("catches up with what another device did, from the answer", () => {
    expect(
      afterScan(ticket(), { outcome: "already_inside", ticket: ann, admittedAt: null }, at)
        ?.checkIn,
    ).toBe("inside");
    expect(
      afterScan(
        ticket({ checkIn: "inside" }),
        { outcome: "reentry_denied", ticket: ann, leftAt },
        at,
      ),
    ).toMatchObject({ checkIn: "left", leftAt });
    expect(
      afterScan(
        ticket({ checkIn: "inside" }),
        { outcome: "not_inside", ticket: ann, leftAt: null },
        at,
      ),
    ).toMatchObject({ checkIn: "not-arrived", leftAt: null });
    expect(
      afterScan(
        ticket(),
        { outcome: "waiver_missing", ticket: ann, reason: "guardian_pending" },
        at,
      ),
    ).toMatchObject({ waiver: "waiting" });
  });

  it("takes a ticket that no longer gets anyone in off the list", () => {
    expect(afterScan(ticket(), { outcome: "invalid_ticket", reason: "cancelled" }, at)).toBeNull();
  });
});

describe("searchDoorList", () => {
  it("matches every word against first or last names, sorted by last name", () => {
    const list = [
      ticket({ ticketId: "3", firstName: "Sam", lastName: "Young", attendeeName: "Sam Young" }),
      ticket({ ticketId: "1", firstName: "Sam", lastName: "Lee", attendeeName: "Sam Lee" }),
      ticket({ ticketId: "2", firstName: "Samira", lastName: "Ali", attendeeName: "Samira Ali" }),
    ];
    expect(searchDoorList(list, "sam").tickets.map((t) => t.attendeeName)).toEqual([
      "Samira Ali",
      "Sam Lee",
      "Sam Young",
    ]);
    expect(searchDoorList(list, " SAM  le ").tickets.map((t) => t.attendeeName)).toEqual([
      "Sam Lee",
    ]);
    // Results carry only what a lookup by name would.
    expect(Object.keys(searchDoorList(list, "lee").tickets[0]!).sort()).toEqual(
      ["attendeeName", "checkIn", "grade", "ticketId", "ticketTypeName", "waiver"].sort(),
    );
  });

  it("lists as many as a lookup does and says there are more", () => {
    const list = Array.from({ length: DOOR_LOOKUP_LIMIT + 1 }, (_, i) =>
      ticket({ ticketId: String(i).padStart(3, "0") }),
    );
    const found = searchDoorList(list, "ann");
    expect(found.tickets).toHaveLength(DOOR_LOOKUP_LIMIT);
    expect(found.more).toBe(true);
  });
});

describe("doorListSchema", () => {
  it("turns the API's ISO strings back into dates", () => {
    const parsed = doorListSchema.parse({
      reentryAllowed: false,
      fetchedAt: "2026-05-03T01:00:00.000Z",
      tickets: [{ ...ticket(), leftAt: "2026-05-02T23:00:00.000Z" }],
    });
    expect(parsed.fetchedAt).toEqual(new Date("2026-05-03T01:00:00Z"));
    expect(parsed.tickets[0]!.leftAt).toEqual(leftAt);
  });
});
