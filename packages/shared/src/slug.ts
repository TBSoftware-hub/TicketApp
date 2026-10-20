/** Turns a name into a web-address slug that passes createOrganizationSchema, e.g. "St. Mary's PTA" → "st-marys-pta". */
export function slugify(name: string, maxLength = 60): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, "");
}
