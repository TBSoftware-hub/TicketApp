import { describe, expect, it } from "vitest";
import { createOrganizationSchema } from "./orgs";
import { slugify } from "./slug";

describe("slugify", () => {
  it("makes a valid organization web address from a name", () => {
    expect(slugify("St. Mary's PTA")).toBe("st-marys-pta");
    expect(slugify("  Lincoln High — Class of 2027! ")).toBe("lincoln-high-class-of-2027");
    expect(slugify("Café Société")).toBe("cafe-societe");
  });

  it("produces slugs the organization schema accepts", () => {
    for (const name of ["Lincoln High School PTSA", "A--B", "x".repeat(80) + " end"]) {
      const slug = slugify(name);
      const result = createOrganizationSchema.shape.slug.safeParse(slug);
      expect(result.success, slug).toBe(true);
    }
  });
});
