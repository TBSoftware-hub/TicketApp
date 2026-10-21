import { describe, expect, it } from "vitest";
import { confirmationEmail } from "./confirmations";

describe("confirmationEmail", () => {
  const order = {
    buyerName: "Pat <Parent>",
    buyerEmail: "pat@example.com",
    totalCents: 2500,
    orderUrl: "https://tickets.test/e/ths/prom/orders/1?key=a&b",
    event: {
      name: "Prom & After",
      startsAt: new Date("2099-05-01T23:00:00Z"),
      endsAt: new Date("2099-05-02T03:00:00Z"),
      venue: "Gym",
      organization: { name: "Test High", timezone: "America/New_York" },
    },
    tickets: [
      {
        code: "abc",
        ticketType: { name: "General" },
        attendee: { firstName: "Sam", lastName: "Lee" },
      },
    ],
  };

  it("escapes names in the HTML", async () => {
    const mail = await confirmationEmail(order);
    expect(mail.html).toContain("Pat &lt;Parent&gt;");
    expect(mail.html).toContain("Prom &amp; After");
    expect(mail.html).toContain('href="https://tickets.test/e/ths/prom/orders/1?key=a&amp;b"');
    expect(mail.html).not.toContain("<Parent>");
  });

  it("shows the time in the organization's time zone", async () => {
    const mail = await confirmationEmail(order);
    expect(mail.text).toContain("When: Fri, May 1, 2099, 7:00 PM – 11:00 PM");
    expect(mail.text).toContain("Where: Gym");
    expect(mail.text).toContain("Total paid: $25.00");
  });
});
