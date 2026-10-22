/**
 * A CSV cell. Quoted when it needs to be, and a leading = + - @ is defused so a spreadsheet
 * doesn't run what an attendee typed as a formula.
 */
export function csvCell(value: string | number | null | undefined) {
  let v = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** A whole CSV file. CRLF line ends and a byte-order mark, so Excel reads it as UTF-8 everywhere. */
export function csvFile(rows: (string | number | null | undefined)[][]) {
  return `\uFEFF${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** "2026-10-22 14:50", in the organization's time zone, which is how spreadsheets sort well. */
export function localTime(instant: Date | null | undefined, timeZone: string) {
  if (!instant) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
