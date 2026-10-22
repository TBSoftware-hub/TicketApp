import type { Prisma } from "@ticketapp/db";
import type { WaiverField } from "@ticketapp/shared";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { waiverDocumentHash } from "./canonical";

/** What a ticket's signed-waiver PDF is made from. */
export const ticketWaiverFields = {
  id: true,
  attendee: { select: { firstName: true, lastName: true } },
  ticketType: { select: { name: true } },
  order: { select: { buyerName: true } },
  event: {
    select: {
      name: true,
      startsAt: true,
      organization: { select: { name: true, timezone: true } },
    },
  },
  signatures: {
    orderBy: [{ signedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      waiverTemplateId: true,
      templateVersion: true,
      signerRole: true,
      signerName: true,
      signedAt: true,
      ipAddress: true,
      userAgent: true,
      documentHash: true,
      answers: true,
    },
  },
  // Where the guardian's signing link actually went, channel by channel.
  guardianRequest: {
    select: {
      emailDeliveredAt: true,
      textDeliveredAt: true,
      guardian: { select: { email: true, phone: true } },
    },
  },
} as const satisfies Prisma.TicketSelect;

export type TicketWaivers = Prisma.TicketGetPayload<{ select: typeof ticketWaiverFields }>;

/** The exact waiver wording a signature was made against. */
export interface SignedVersion {
  waiverTemplateId: string;
  version: number;
  title: string;
  body: string;
  fields: unknown;
}

/** Loads the waiver versions a ticket's signatures point at. */
export async function signedVersions(
  db: Prisma.TransactionClient,
  ticket: TicketWaivers,
): Promise<SignedVersion[]> {
  if (ticket.signatures.length === 0) return [];
  return db.waiverTemplateVersion.findMany({
    where: {
      OR: ticket.signatures.map((s) => ({
        waiverTemplateId: s.waiverTemplateId,
        version: s.templateVersion,
      })),
    },
    select: { waiverTemplateId: true, version: true, title: true, body: true, fields: true },
  });
}

const PAGE = { width: 612, height: 792 }; // US Letter
const MARGIN = 56;
const WIDTH = PAGE.width - MARGIN * 2;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.4, 0.4, 0.45);
const WARN = rgb(0.7, 0.1, 0.1);

const ROLE = { ATTENDEE: "Attendee", GUARDIAN: "Parent or guardian" } as const;

/** Lays text out top to bottom, starting new pages as it runs off the end of one. */
class Writer {
  private page: PDFPage;
  private y: number;
  private readonly safe = new Map<string, boolean>();

  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    private readonly footer: string,
  ) {
    this.page = this.addPage();
    this.y = PAGE.height - MARGIN;
  }

  private addPage() {
    const page = this.doc.addPage([PAGE.width, PAGE.height]);
    page.drawText(this.clean(this.footer, this.regular), {
      x: MARGIN,
      y: MARGIN / 2,
      size: 8,
      font: this.regular,
      color: MUTED,
    });
    return page;
  }

  /**
   * The standard PDF fonts only cover Western European characters, so anything else (emoji,
   * other scripts) shows as "?" rather than failing the whole document.
   */
  private clean(text: string, font: PDFFont) {
    return [...text.replace(/\t/g, "    ")]
      .map((ch) => {
        const key = `${font.name}:${ch}`;
        if (!this.safe.has(key)) {
          try {
            font.encodeText(ch);
            this.safe.set(key, true);
          } catch {
            this.safe.set(key, false);
          }
        }
        return this.safe.get(key) ? ch : "?";
      })
      .join("");
  }

  /**
   * Breaks text into lines that fit the page. Widths are added up a character at a time, so even
   * the longest waiver lays out in one pass.
   */
  private wrap(text: string, font: PDFFont, size: number) {
    const width = (ch: string) => font.widthOfTextAtSize(ch, size);
    const space = width(" ");
    const lines: string[] = [];
    // Split first: line breaks aren't in the font, so cleaning would turn them into "?".
    for (const paragraph of text.split(/\r?\n/)) {
      let line = "";
      let lineWidth = 0;
      for (const word of this.clean(paragraph, font).split(" ")) {
        const chars = [...word];
        const widths = chars.map(width);
        const wordWidth = widths.reduce((a, b) => a + b, 0);
        if (line && lineWidth + space + wordWidth <= WIDTH) {
          line += ` ${word}`;
          lineWidth += space + wordWidth;
          continue;
        }
        if (line) lines.push(line);
        // A single word wider than the page (a long hash or URL) is broken where it overflows.
        line = "";
        lineWidth = 0;
        chars.forEach((ch, i) => {
          if (line && lineWidth + widths[i]! > WIDTH) {
            lines.push(line);
            line = "";
            lineWidth = 0;
          }
          line += ch;
          lineWidth += widths[i]!;
        });
      }
      lines.push(line);
    }
    return lines;
  }

  text(
    text: string,
    { size = 10, bold = false, color = INK, after = 4 } = {} as {
      size?: number;
      bold?: boolean;
      color?: typeof INK;
      after?: number;
    },
  ) {
    const font = bold ? this.bold : this.regular;
    const leading = size * 1.35;
    for (const line of this.wrap(text, font, size)) {
      if (this.y - leading < MARGIN) {
        this.page = this.addPage();
        this.y = PAGE.height - MARGIN;
      }
      this.y -= leading;
      this.page.drawText(line, { x: MARGIN, y: this.y, size, font, color });
    }
    this.y -= after;
  }

  gap(points = 10) {
    this.y -= points;
  }

  rule() {
    if (this.y - 12 < MARGIN) return;
    this.y -= 6;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE.width - MARGIN, y: this.y },
      thickness: 0.5,
      color: MUTED,
    });
    this.y -= 12;
  }
}

function answerText(field: WaiverField, value: unknown) {
  if (field.type === "CHECKBOX") return value === true ? "Yes" : "No";
  return typeof value === "string" && value ? value : "(left blank)";
}

/**
 * A ticket's signed waivers as a PDF: each waiver's wording in the version that was signed, the
 * answers given, who signed and when, then an audit trail with each signature's time, IP address,
 * browser and document hash, checked against the stored wording.
 *
 * With `answers: false` the answers are left out, and the copy says so: a vendor's copy, since
 * answers to a waiver's questions can be medical.
 */
export async function waiverPdf(
  ticket: TicketWaivers,
  versions: SignedVersion[],
  now = new Date(),
  { answers: showAnswers = true }: { answers?: boolean } = {},
): Promise<Uint8Array> {
  const { event, attendee } = ticket;
  const { timezone } = event.organization;
  const attendeeName = `${attendee.firstName} ${attendee.lastName}`;
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "long",
  });

  const doc = await PDFDocument.create();
  doc.setTitle(`Signed waivers: ${attendeeName}, ${event.name}`);
  doc.setAuthor(event.organization.name);
  doc.setProducer("TicketApp");
  doc.setCreator("TicketApp");
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  const out = new Writer(
    doc,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
    // Kept to fixed-length identifiers so it always fits; the names are in the heading.
    `Ticket ${ticket.id} · Generated ${now.toISOString()}`,
  );

  const versionOf = (s: { waiverTemplateId: string; templateVersion: number }) =>
    versions.find(
      (v) => v.waiverTemplateId === s.waiverTemplateId && v.version === s.templateVersion,
    );

  out.text(event.organization.name, { size: 10, color: MUTED, after: 2 });
  out.text("Signed waivers", { size: 20, bold: true, after: 6 });
  out.text(`${attendeeName} · ${ticket.ticketType.name}`, { size: 12, bold: true, after: 2 });
  out.text(`${event.name}, ${when.format(event.startsAt)}`, { after: 2 });
  out.text(`Bought by ${ticket.order.buyerName}`, { color: MUTED });
  out.rule();

  // One section per waiver, in the order it was first signed.
  const waivers = [
    ...new Set(ticket.signatures.map((s) => `${s.waiverTemplateId}:${s.templateVersion}`)),
  ];
  for (const key of waivers) {
    const signatures = ticket.signatures.filter(
      (s) => `${s.waiverTemplateId}:${s.templateVersion}` === key,
    );
    const version = versionOf(signatures[0]!);
    if (!version) continue;
    out.text(version.title, { size: 14, bold: true, after: 2 });
    out.text(`Version ${version.version}`, { size: 9, color: MUTED, after: 8 });
    out.text(version.body, { after: 10 });

    const fields = (version.fields ?? []) as WaiverField[];
    // The attendee answers the questions; a guardian signs against those same answers.
    const attendee = signatures.find((s) => s.signerRole === "ATTENDEE");
    if (attendee && fields.length > 0 && !showAnswers) {
      out.text("Answers", { bold: true, after: 2 });
      out.text(
        `${fields.length === 1 ? "1 answer" : `${fields.length} answers`} left out of this copy, ` +
          "since they can include medical details. The organizer has them on file.",
        { size: 9, color: MUTED, after: 8 },
      );
    } else if (attendee && fields.length > 0) {
      const answers = (attendee.answers ?? {}) as Record<string, unknown>;
      out.text("Answers", { bold: true, after: 2 });
      for (const f of fields) {
        out.text(`${f.label}: ${answerText(f, answers[f.id])}`, { after: f.help ? 1 : 2 });
        // Help text is part of what was signed, so the copy keeps it.
        if (f.help) out.text(f.help, { size: 9, color: MUTED, after: 3 });
      }
      out.gap(6);
    }
    for (const s of signatures) {
      out.text(`Signed by ${s.signerName} (${ROLE[s.signerRole].toLowerCase()})`, {
        bold: true,
        after: 2,
      });
      out.text(when.format(s.signedAt), { color: MUTED, after: 6 });
    }
    out.rule();
  }

  out.text("Audit trail", { size: 14, bold: true, after: 4 });
  out.text(
    "The document hash is a SHA-256 fingerprint of the waiver's title, wording and questions as " +
      "the signer saw them. It's recorded at signing and checked again here against the stored " +
      "wording, so any change after signing would show as a mismatch.",
    { size: 9, color: MUTED, after: 10 },
  );
  for (const s of ticket.signatures) {
    const version = versionOf(s);
    const matches = version ? waiverDocumentHash(version) === s.documentHash : false;
    out.text(`${s.signerName}, ${ROLE[s.signerRole].toLowerCase()}`, { bold: true, after: 2 });
    const rows: [string, string][] = [
      [
        "Waiver",
        version
          ? `${version.title} (version ${s.templateVersion})`
          : `Version ${s.templateVersion}`,
      ],
      ["Signed at", `${s.signedAt.toISOString()} (${when.format(s.signedAt)})`],
      ["IP address", s.ipAddress ?? "Not recorded"],
      ["Browser", s.userAgent ?? "Not recorded"],
    ];
    const request = ticket.guardianRequest;
    if (s.signerRole === "GUARDIAN" && request) {
      const sentTo = [
        request.emailDeliveredAt && request.guardian.email,
        request.textDeliveredAt && request.guardian.phone,
      ].filter(Boolean);
      if (sentTo.length > 0) rows.push(["Link sent to", sentTo.join(", ")]);
    }
    rows.push(["Signature ID", s.id], ["Document hash", s.documentHash]);
    for (const [label, value] of rows) out.text(`${label}: ${value}`, { size: 9, after: 1 });
    out.text(
      matches
        ? "Wording check: matches the stored waiver"
        : "Wording check: DOES NOT MATCH the stored waiver",
      { size: 9, bold: true, color: matches ? INK : WARN, after: 10 },
    );
  }

  return doc.save();
}

/** One attendee on a bundle's cover page. */
export interface BundleEntry {
  name: string;
  ticketTypeName: string;
  status: string;
}

/**
 * Every signed waiver for an event in one PDF, for a vendor: a cover page listing each attendee
 * and where their waivers stand, then each ticket's signed-waiver PDF in turn.
 */
export async function waiverBundlePdf(
  event: { name: string; startsAt: Date; organization: { name: string; timezone: string } },
  entries: BundleEntry[],
  ticketPdfs: Uint8Array[],
  now = new Date(),
): Promise<Uint8Array> {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: event.organization.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const doc = await PDFDocument.create();
  doc.setTitle(`Signed waivers: ${event.name}`);
  doc.setAuthor(event.organization.name);
  doc.setProducer("TicketApp");
  doc.setCreator("TicketApp");
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  const out = new Writer(
    doc,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
    `Waiver bundle · Generated ${now.toISOString()}`,
  );
  out.text(event.organization.name, { size: 10, color: MUTED, after: 2 });
  out.text("Signed waivers", { size: 20, bold: true, after: 6 });
  out.text(`${event.name}, ${when.format(event.startsAt)}`, { size: 12, bold: true, after: 2 });
  const signed = ticketPdfs.length;
  out.text(
    `${entries.length} ${entries.length === 1 ? "attendee" : "attendees"} · ` +
      `${signed} with signed waivers in this file · Generated ${when.format(now)}`,
    { color: MUTED, after: 2 },
  );
  out.text("Answers to waiver questions are left out, since they can include medical details.", {
    size: 9,
    color: MUTED,
  });
  out.rule();
  for (const e of entries) {
    out.text(`${e.name} · ${e.ticketTypeName}`, { bold: true, after: 1 });
    out.text(e.status, { size: 9, color: MUTED, after: 6 });
  }
  for (const bytes of ticketPdfs) {
    const part = await PDFDocument.load(bytes);
    const pages = await doc.copyPages(part, part.getPageIndices());
    for (const page of pages) doc.addPage(page);
  }
  return doc.save();
}
