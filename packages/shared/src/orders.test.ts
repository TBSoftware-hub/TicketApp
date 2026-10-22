import { describe, expect, it } from "vitest";
import { resendOrderSchema, transferTicketSchema } from "./orders";

describe("transferTicketSchema", () => {
  it("treats a blank email as none, and tidies one given", () => {
    const base = { firstName: " Jo ", lastName: "Park" };
    expect(transferTicketSchema.parse({ ...base, email: "  " })).toMatchObject({
      firstName: "Jo",
      email: null,
    });
    expect(transferTicketSchema.parse(base).email).toBeNull();
    expect(transferTicketSchema.parse({ ...base, email: " Jo@Example.com " }).email).toBe(
      "jo@example.com",
    );
    expect(transferTicketSchema.safeParse({ ...base, email: "jo" }).success).toBe(false);
    expect(transferTicketSchema.parse({ ...base, studentId: " s-2 " }).studentId).toBe("S-2");
  });
});

describe("resendOrderSchema", () => {
  it("needs a valid email", () => {
    expect(resendOrderSchema.parse({ email: " Pat@Example.com" }).email).toBe("pat@example.com");
    expect(resendOrderSchema.safeParse({ email: "" }).success).toBe(false);
  });
});
