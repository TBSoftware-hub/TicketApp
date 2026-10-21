import type { WaiverField } from "@ticketapp/shared";

export interface WaiverSummary {
  id: string;
  title: string;
  version: number;
  requiresGuardianForMinors: boolean;
  archivedAt: string | null;
  updatedAt: string;
  fieldCount: number;
  eventCount: number;
  signatureCount: number;
}

export interface WaiverRecord extends WaiverSummary {
  body: string;
  fields: WaiverField[];
  events: { id: string; name: string; startsAt: string; endsAt: string }[];
}
