/**
 * Event times are entered as wall-clock time in the organization's time zone ("2026-11-14T19:00")
 * and stored as UTC instants. These helpers convert between the two without a date library.
 */

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (e.g. -4h for New York in summer). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * "2026-11-14T19:00" in `timeZone` → the UTC instant. Returns null for malformed input and for times
 * that don't exist in the zone. A time that occurs twice (when clocks fall back) resolves to one of
 * the two.
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const m = LOCAL_PATTERN.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle the offset across daylight-saving changes.
  let utc = naive - zoneOffsetMs(new Date(naive), timeZone);
  utc = naive - zoneOffsetMs(new Date(utc), timeZone);
  const result = new Date(utc);
  // Times skipped when clocks spring forward (2:30am on that day) don't exist; refuse them rather
  // than quietly picking another time.
  return utcToZonedLocal(result, timeZone) === local ? result : null;
}

/** UTC instant → "2026-11-14T19:00" in `timeZone`, the format of an `<input type="datetime-local">`. */
export function utcToZonedLocal(instant: Date, timeZone: string): string {
  const shifted = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  return shifted.toISOString().slice(0, 16);
}

/** "Sat, Nov 14, 2026, 7:00 PM – 10:00 PM" in the organization's time zone. */
export function formatEventTime(
  startsAt: string | Date,
  endsAt: string | Date,
  timeZone: string,
): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const sameDay = day.format(start) === day.format(end);
  return sameDay
    ? `${day.format(start)}, ${time.format(start)} – ${time.format(end)}`
    : `${day.format(start)}, ${time.format(start)} – ${day.format(end)}, ${time.format(end)}`;
}
