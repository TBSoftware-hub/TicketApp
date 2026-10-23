import { describe, expect, it } from "vitest";
import {
  describeScan,
  doorEventTiming,
  doorScanResultSchema,
  doorScanSchema,
  formatDoorEventTime,
  doorEventsResponseSchema,
  verifySignInCodeSchema,
} from "./index";

describe("doorEventTiming", () => {
  const now = new Date("2026-05-02T21:00:00Z");
  const event = (startsAt: string) => ({
    startsAt: new Date(startsAt),
    endsAt: new Date("2026-05-03T05:00:00Z"),
  });

  it("counts an event as on once doors open, two hours before the start", () => {
    expect(doorEventTiming(event("2026-05-02T22:00:00Z"), now)).toBe("now");
    expect(doorEventTiming(event("2026-05-02T23:00:00Z"), now)).toBe("now");
    expect(doorEventTiming(event("2026-05-02T20:00:00Z"), now)).toBe("now");
  });

  it("counts a later event as coming up", () => {
    expect(doorEventTiming(event("2026-05-02T23:00:01Z"), now)).toBe("later");
  });
});

describe("doorEventsResponseSchema", () => {
  it("turns the API's ISO strings back into dates", () => {
    const parsed = doorEventsResponseSchema.parse({
      events: [
        {
          id: "01a1562f-061b-72dd-a3fe-40770af4ed8f",
          name: "After-prom",
          venue: null,
          startsAt: "2026-05-02T22:00:00.000Z",
          endsAt: "2026-05-03T05:00:00.000Z",
          organization: {
            id: "01a1562f-0602-752e-bd2d-339b4e796e33",
            name: "Lincoln PTA",
            timezone: "America/Chicago",
          },
        },
      ],
    });
    expect(parsed.events[0]!.startsAt).toEqual(new Date("2026-05-02T22:00:00Z"));
  });
});

describe("verifySignInCodeSchema", () => {
  it("accepts the code with the space the email shows", () => {
    expect(verifySignInCodeSchema.parse({ email: "Door@Example.com", code: " 123 456 " })).toEqual({
      email: "door@example.com",
      code: "123456",
    });
  });

  it("rejects anything but six digits", () => {
    expect(verifySignInCodeSchema.safeParse({ email: "a@b.co", code: "12345" }).success).toBe(
      false,
    );
    expect(verifySignInCodeSchema.safeParse({ email: "a@b.co", code: "12345a" }).success).toBe(
      false,
    );
  });
});

describe("formatDoorEventTime", () => {
  const organization = { timezone: "America/New_York" };
  const format = (startsAt: string, endsAt: string) =>
    formatDoorEventTime({
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      organization: organization as never,
    });

  it("shows the day once and both times in the organization's time zone", () => {
    expect(format("2026-05-02T23:00:00Z", "2026-05-03T02:00:00Z")).toBe(
      "Sat, May 2 · 7:00 PM – 10:00 PM",
    );
  });

  it("keeps an overnight event on its start day", () => {
    expect(format("2026-05-03T02:00:00Z", "2026-05-03T09:00:00Z")).toBe(
      "Sat, May 2 · 10:00 PM – 5:00 AM",
    );
  });

  it("shows the end day for an event longer than a day", () => {
    expect(format("2026-05-02T13:00:00Z", "2026-05-04T20:00:00Z")).toBe(
      "Sat, May 2 · 9:00 AM – Mon, May 4, 4:00 PM",
    );
  });
});

describe("describeScan", () => {
  const ticket = { attendeeName: "Ann Lee", ticketTypeName: "Guest" };

  it("says to let a valid ticket in, with who it's for", () => {
    expect(describeScan({ outcome: "admitted", ticket }, "America/New_York")).toEqual({
      tone: "go",
      title: "Let them in",
      lines: ["Ann Lee", "Guest"],
    });
  });

  it("gives the time an already-used ticket got someone in, in the event's time zone", () => {
    const result = doorScanResultSchema.parse({
      outcome: "already_inside",
      ticket,
      admittedAt: "2026-05-02T23:42:00.000Z",
    });
    expect(describeScan(result, "America/New_York")).toEqual({
      tone: "warn",
      title: "Already checked in",
      lines: ["Ann Lee", "This ticket got someone in at 7:42 PM."],
    });
  });

  it("still warns about a used ticket when the time isn't on record", () => {
    const display = describeScan(
      { outcome: "already_inside", ticket, admittedAt: null },
      "America/New_York",
    );
    expect(display.lines[1]).toBe("This ticket has already been used.");
  });

  it("names who's held up by a missing waiver, and offers an override", () => {
    expect(
      describeScan(
        { outcome: "waiver_missing", ticket, reason: "guardian_pending" },
        "America/New_York",
      ),
    ).toEqual({
      tone: "stop",
      title: "Waiver missing",
      lines: ["Ann Lee", "Their parent or guardian hasn't signed the waiver yet."],
      overridable: true,
    });
  });

  it("says why a ticket won't get anyone in", () => {
    expect(
      describeScan({ outcome: "invalid_ticket", reason: "transferred" }, "America/New_York"),
    ).toEqual({
      tone: "stop",
      title: "Not a valid ticket",
      lines: ["This ticket was given to someone else, who has a new code."],
    });
  });
});

describe("doorScanSchema", () => {
  it("trims an override reason and turns away one too short to mean anything", () => {
    const scanKey = "01a16685-93bb-72a0-ade3-a9d89f418403";
    expect(
      doorScanSchema.parse({ scanKey, code: "abc", overrideReason: " Paper waiver " }),
    ).toEqual({ scanKey, code: "abc", overrideReason: "Paper waiver" });
    expect(doorScanSchema.safeParse({ scanKey, code: "abc", overrideReason: " ok " }).success).toBe(
      false,
    );
  });

  it("trims the scanned code and turns away an empty one", () => {
    const scanKey = "01a16685-93bb-72a0-ade3-a9d89f418403";
    expect(doorScanSchema.parse({ scanKey, code: " abc\n" })).toEqual({ scanKey, code: "abc" });
    expect(doorScanSchema.safeParse({ scanKey, code: "  " }).success).toBe(false);
  });

  it("lets a long QR code through, to be answered as not a ticket", () => {
    const scanKey = "01a16685-93bb-72a0-ade3-a9d89f418403";
    expect(doorScanSchema.safeParse({ scanKey, code: "x".repeat(1000) }).success).toBe(true);
  });
});
