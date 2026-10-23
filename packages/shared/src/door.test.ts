import { describe, expect, it } from "vitest";
import {
  doorEventTiming,
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
