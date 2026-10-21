import type { WaiverAnswer, WaiverField } from "@ticketapp/shared";

/** A guardian's signing request, as the link in their email or text shows it. */
export interface GuardianRequest {
  guardianName: string;
  buyerName: string;
  attendee: { firstName: string; lastName: string };
  event: {
    name: string;
    startsAt: string;
    endsAt: string;
    venue: string | null;
    organizationName: string;
    timezone: string;
  };
  /** The waivers to sign, in the version the attendee signed, with the attendee's answers. */
  waivers: {
    id: string;
    version: number;
    title: string;
    body: string;
    fields: WaiverField[];
    answers: Record<string, WaiverAnswer>;
  }[];
  signedAt: string | null;
  signerName: string | null;
}
