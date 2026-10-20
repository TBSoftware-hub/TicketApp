import { describe, expect, it } from "vitest";
import { utcToZonedLocal, zonedLocalToUtc } from "./time";

describe("zoned time", () => {
  it("converts wall-clock time in a zone to UTC", () => {
    expect(zonedLocalToUtc("2026-11-14T19:00", "America/New_York")?.toISOString()).toBe(
      "2026-11-15T00:00:00.000Z",
    );
    expect(zonedLocalToUtc("2026-07-04T19:00", "America/New_York")?.toISOString()).toBe(
      "2026-07-04T23:00:00.000Z",
    );
    expect(zonedLocalToUtc("2026-07-04T19:00", "America/Phoenix")?.toISOString()).toBe(
      "2026-07-05T02:00:00.000Z",
    );
  });

  it("handles the day daylight saving ends", () => {
    // Nov 1 2026: clocks fall back at 2am in New York, so 10am is UTC-5.
    expect(zonedLocalToUtc("2026-11-01T10:00", "America/New_York")?.toISOString()).toBe(
      "2026-11-01T15:00:00.000Z",
    );
  });

  it("round-trips", () => {
    const local = "2027-03-20T18:30";
    expect(utcToZonedLocal(zonedLocalToUtc(local, "America/Chicago")!, "America/Chicago")).toBe(
      local,
    );
  });

  it("refuses a time skipped when clocks spring forward", () => {
    expect(zonedLocalToUtc("2027-03-14T02:30", "America/New_York")).toBeNull();
    expect(zonedLocalToUtc("2027-03-14T03:30", "America/New_York")?.toISOString()).toBe(
      "2027-03-14T07:30:00.000Z",
    );
  });

  it("rejects malformed input", () => {
    expect(zonedLocalToUtc("tomorrow", "America/New_York")).toBeNull();
  });
});
