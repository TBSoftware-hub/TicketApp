import { describe, expect, it } from "vitest";
import { createTwilioTexter, texterFromEnv } from "./texter";

describe("texting", () => {
  it("sends through Twilio's API", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const texter = createTwilioTexter(
      { accountSid: "AC123", authToken: "secret", from: "+15550001111" },
      async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return new Response("{}", { status: 201 });
      },
    );
    await texter.send({ to: "+15552013344", body: "Hello" });
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
    );
    expect(Object.fromEntries(calls[0]!.init.body as URLSearchParams)).toEqual({
      To: "+15552013344",
      Body: "Hello",
      From: "+15550001111",
    });
  });

  it("uses a messaging service when given one, and reports refusals", async () => {
    let body: URLSearchParams | undefined;
    const texter = createTwilioTexter(
      { accountSid: "AC123", authToken: "secret", from: "MG999" },
      async (_url, init) => {
        body = init!.body as URLSearchParams;
        return new Response("invalid number", { status: 400 });
      },
    );
    await expect(texter.send({ to: "+15552013344", body: "Hi" })).rejects.toThrow(
      "Twilio rejected the text: 400 invalid number",
    );
    expect(body?.get("MessagingServiceSid")).toBe("MG999");
  });

  it("is set up from the environment only when all three settings are there", () => {
    expect(texterFromEnv({})).toBeUndefined();
    expect(() => texterFromEnv({ TWILIO_ACCOUNT_SID: "AC123" })).toThrow(
      "Set all of TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to send texts",
    );
    expect(
      texterFromEnv({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "+1555" }),
    ).toBeDefined();
  });
});
