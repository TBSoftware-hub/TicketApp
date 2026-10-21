import { api } from "./api";
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
  events: { id: string; name: string; startsAt: string; endsAt: string; ticketTypes: string[] }[];
}

export interface WaiverChoice {
  id: string;
  title: string;
  archived: boolean;
}

/** Waivers a ticket type can ask for: active ones, plus archived ones it already has. */
export function waiverChoices(waivers: WaiverSummary[], attached: string[] = []): WaiverChoice[] {
  return waivers
    .filter((w) => !w.archivedAt || attached.includes(w.id))
    .map((w) => ({ id: w.id, title: w.title, archived: w.archivedAt !== null }));
}

/** The organization's waivers, for pages that let staff pick some. */
export async function loadWaiverSummaries(orgId: string, token: string) {
  const { status, data } = await api<{ waivers: WaiverSummary[] }>(
    `/orgs/${encodeURIComponent(orgId)}/waivers`,
    { token },
  );
  if (!("waivers" in data)) throw new Error(`Couldn't load waivers (${status})`);
  return data.waivers;
}
