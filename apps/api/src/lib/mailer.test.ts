import { describe, expect, it } from "vitest";
import { createResendMailer, mailerFromEnv } from "./mailer";

describe("mailerFromEnv", () => {
  it("returns no mailer when SMTP isn't configured", () => {
    expect(mailerFromEnv({})).toBeUndefined();
  });

  it("requires a sender address alongside a provider", () => {
    expect(() => mailerFromEnv({ RESEND_API_KEY: "re_test" })).toThrow(/MAIL_FROM/);
    expect(() => mailerFromEnv({ SMTP_URL: "smtp://localhost:2525" })).toThrow(/MAIL_FROM/);
  });

  it("builds an SMTP mailer when both are set", () => {
    const mailer = mailerFromEnv({ SMTP_URL: "smtp://localhost:2525", MAIL_FROM: "a@b.test" });
    expect(mailer).toBeDefined();
  });

  it("posts the message to Resend's API", async () => {
    const calls: [string, RequestInit][] = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init!]);
      return new Response("{}", { status: 200 });
    };
    const mailer = createResendMailer("re_test", "TicketApp <a@b.test>", fakeFetch as typeof fetch);
    await mailer.send({ to: "x@example.com", subject: "Hi", text: "Body" });

    expect(calls[0]![0]).toBe("https://api.resend.com/emails");
    expect(new Headers(calls[0]![1].headers).get("authorization")).toBe("Bearer re_test");
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({
      from: "TicketApp <a@b.test>",
      to: "x@example.com",
      subject: "Hi",
      text: "Body",
    });
  });

  it("sends inline images to Resend as attachments with content ids", async () => {
    const bodies: unknown[] = [];
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return new Response("{}", { status: 200 });
    };
    const mailer = createResendMailer("re_test", "a@b.test", fakeFetch as typeof fetch);
    await mailer.send({
      to: "x@example.com",
      subject: "Hi",
      text: "Body",
      html: '<img src="cid:qr">',
      inlineImages: [
        {
          filename: "qr.png",
          content: Buffer.from("png"),
          contentType: "image/png",
          contentId: "qr",
        },
      ],
    });
    expect(bodies[0]).toMatchObject({
      html: '<img src="cid:qr">',
      attachments: [
        { filename: "qr.png", content: "cG5n", content_type: "image/png", content_id: "qr" },
      ],
    });
  });

  it("fails when Resend rejects the message", async () => {
    const fakeFetch = async () => new Response("bad key", { status: 401 });
    const mailer = createResendMailer("re_bad", "a@b.test", fakeFetch as typeof fetch);
    await expect(mailer.send({ to: "x@example.com", subject: "Hi", text: "B" })).rejects.toThrow(
      /401/,
    );
  });
});
