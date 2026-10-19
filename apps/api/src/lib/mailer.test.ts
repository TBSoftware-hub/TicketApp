import { describe, expect, it } from "vitest";
import { mailerFromEnv } from "./mailer";

describe("mailerFromEnv", () => {
  it("returns no mailer when SMTP isn't configured", () => {
    expect(mailerFromEnv({})).toBeUndefined();
  });

  it("requires a sender address alongside SMTP_URL", () => {
    expect(() => mailerFromEnv({ SMTP_URL: "smtp://localhost:2525" })).toThrow(/MAIL_FROM/);
  });

  it("builds an SMTP mailer when both are set", () => {
    const mailer = mailerFromEnv({ SMTP_URL: "smtp://localhost:2525", MAIL_FROM: "a@b.test" });
    expect(mailer).toBeDefined();
  });
});
