/** Amounts are stored as integer cents everywhere; format only at the edges. */
export function formatCents(cents: number, currency = "USD", locale = "en-US"): string {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`Expected integer cents, got ${cents}`);
  }
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}
