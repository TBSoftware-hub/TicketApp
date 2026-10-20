/** Amounts are stored as integer cents everywhere; format only at the edges. */
export function formatCents(cents: number, currency = "USD", locale = "en-US"): string {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`Expected integer cents, got ${cents}`);
  }
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

/** Parses what someone typed as a price ("12", "12.5", "$1,012.50") into cents, or null. */
export function parseDollarsToCents(input: string): number | null {
  const cleaned = input
    .trim()
    .replace(/^\$/, "")
    .replace(/,(?=\d{3}(\D|$))/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}
