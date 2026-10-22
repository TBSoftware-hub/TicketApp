import { describe, expect, it } from "vitest";
import { pdfText } from "../test-helpers";
import { waiverDocumentHash } from "./canonical";
import { waiverPdf, type SignedVersion, type TicketWaivers } from "./waiver-pdf";

describe("signed waiver PDFs", () => {
  const version: SignedVersion = {
    waiverTemplateId: "w1",
    version: 2,
    title: "Dance Waiver",
    body: `Have fun 🎉 at the dance.\n\n${"Long wording. ".repeat(1000)}\n${"x".repeat(300)}`,
    fields: [
      {
        id: "photo",
        label: "Photos are OK",
        type: "CHECKBOX",
        required: false,
        help: "Photos may appear in the yearbook.",
      },
      { id: "allergy", label: "Allergies", type: "TEXT", required: false },
    ],
  };
  const ticket: TicketWaivers = {
    id: "t1",
    attendee: { firstName: "Zoë", lastName: "Kim" },
    ticketType: { name: "Student" },
    order: { buyerName: "Ana Kim" },
    event: {
      name: "Winter Formal",
      startsAt: new Date("2026-12-12T01:00:00Z"),
      organization: { name: "Test High", timezone: "America/Chicago" },
    },
    signatures: [
      {
        id: "s1",
        waiverTemplateId: "w1",
        templateVersion: 2,
        signerRole: "ATTENDEE",
        signerName: "Zoë Kim",
        signedAt: new Date("2026-11-01T15:30:00Z"),
        ipAddress: null,
        userAgent: null,
        documentHash: waiverDocumentHash(version),
        answers: { photo: true },
      },
      {
        id: "s2",
        waiverTemplateId: "w1",
        templateVersion: 2,
        signerRole: "GUARDIAN",
        signerName: "Ana Kim",
        signedAt: new Date("2026-11-01T16:00:00Z"),
        ipAddress: "203.0.113.9",
        userAgent: "Phone",
        documentHash: waiverDocumentHash(version),
        answers: {},
      },
    ],
    // The email went out; the text didn't, so the phone number isn't listed as sent to.
    guardianRequest: {
      emailDeliveredAt: new Date("2026-11-01T15:31:00Z"),
      textDeliveredAt: null,
      guardian: { email: "ana@example.com", phone: "+15552013344" },
    },
  };

  it("lays out long wording over several pages, and shows unsupported characters as ?", async () => {
    const text = pdfText(await waiverPdf(ticket, [version], new Date("2026-11-02T00:00:00Z")));
    expect(text).toContain("Zoë Kim · Student");
    const lines = text.split("\n");
    // Line breaks in the wording stay line breaks.
    expect(lines).toContain("Have fun ? at the dance.");
    expect(text).not.toContain("??");
    expect(text).toContain("Link sent to: ana@example.com\n");
    expect(text).toContain("Winter Formal, Dec 11, 2026, 7:00:00 PM CST");
    expect(text).toContain("Photos are OK: Yes\nPhotos may appear in the yearbook.");
    expect(text).toContain("Allergies: (left blank)");
    expect(text).toContain("IP address: Not recorded");
    expect(text).toContain("Signed at: 2026-11-01T15:30:00.000Z (Nov 1, 2026, 9:30:00 AM CST)");
    expect(text).toContain("Wording check: matches the stored waiver");
    expect(
      text.split("\n").filter((l) => l.startsWith("Ticket t1 · Generated ")).length,
    ).toBeGreaterThan(2);
  });

  it("lays out the longest allowed wording quickly, even with no spaces", async () => {
    const started = performance.now();
    const pdf = await waiverPdf(ticket, [{ ...version, body: "x".repeat(20_000) }]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(pdfText(pdf)).toContain("x".repeat(50));
  });
});
