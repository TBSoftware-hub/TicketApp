"use server";

import {
  createEventSchema,
  createInvitationSchema,
  createOrganizationSchema,
  createTicketTypeSchema,
  parseDollarsToCents,
  zonedLocalToUtc,
} from "@ticketapp/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { api, errorMessage } from "../lib/api";
import { clearSessionToken, getSessionToken, setSessionToken } from "../lib/session";

export async function verifySignIn(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const { status, data } = await api<{ sessionToken: string }>("/auth/verify", {
    method: "POST",
    body: { token },
  });
  // Only a 400 means the link itself is bad; anything else leaves it unused, so offer a retry.
  if (status === 400) redirect("/sign-in?expired=1");
  if (status !== 200 || !("sessionToken" in data)) {
    redirect(`/sign-in/verify?token=${encodeURIComponent(token)}&retry=1`);
  }
  await setSessionToken(data.sessionToken);
  redirect("/");
}

export async function signOut() {
  const token = await getSessionToken();
  // api() never throws, so the local session is cleared even if the API can't be reached.
  if (token) await api("/auth/sign-out", { method: "POST", token });
  await clearSessionToken();
  redirect("/sign-in");
}

export interface FormState {
  error?: string;
}

export async function createOrganization(_prev: FormState, formData: FormData): Promise<FormState> {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");

  const parsed = createOrganizationSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    type: formData.get("type"),
    timezone: formData.get("timezone") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };

  const { status, data } = await api("/orgs", { method: "POST", token, body: parsed.data });
  if (status === 401) redirect("/sign-in");
  if (status !== 201) return { error: errorMessage(data) };
  redirect("/");
}

export interface InviteState extends FormState {
  sentTo?: string;
}

export async function inviteMember(
  orgId: string,
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");

  const parsed = createInvitationSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };

  const { status, data } = await api(`/orgs/${encodeURIComponent(orgId)}/invitations`, {
    method: "POST",
    token,
    body: parsed.data,
  });
  if (status === 401) redirect("/sign-in");
  if (status !== 201) return { error: errorMessage(data) };
  revalidatePath(`/orgs/${orgId}/team`);
  return { sentTo: parsed.data.email };
}

export async function revokeInvitation(formData: FormData) {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const orgId = String(formData.get("orgId") ?? "");
  const invitationId = String(formData.get("invitationId") ?? "");
  const path = `/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`;
  const { status } = await api(path, { method: "DELETE", token });
  if (status === 401) redirect("/sign-in");
  revalidatePath(`/orgs/${orgId}/team`);
  // 404 means it was already accepted or cancelled, which the refreshed list shows. Anything else
  // means the invite may still work, so say so.
  if (status !== 204 && status !== 404) redirect(`/orgs/${orgId}/team?cancelFailed=1`);
  redirect(`/orgs/${orgId}/team`);
}

export async function acceptInvitation(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("name") ?? "").trim() || undefined;
  const { status, data } = await api<{ sessionToken: string }>("/invitations/accept", {
    method: "POST",
    body: { token, name },
  });
  if (status === 400) redirect("/invite?invalid=1");
  if (status !== 200 || !("sessionToken" in data)) {
    redirect(`/invite?token=${encodeURIComponent(token)}&retry=1`);
  }
  await setSessionToken(data.sessionToken);
  redirect("/");
}

/**
 * Reads a datetime-local field as a UTC instant in the organization's time zone. Null when the field
 * is blank or names a time skipped by a clock change.
 */
function formTime(formData: FormData, name: string, timezone: string): Date | null {
  const local = String(formData.get(name) ?? "");
  const original = String(formData.get(`${name}Original`) ?? "");
  const originalUtc = String(formData.get(`${name}OriginalUtc`) ?? "");
  // An unchanged time keeps its stored instant. During the hour that repeats when clocks fall back,
  // the wall-clock time alone can't say which of the two it meant.
  if (local && local === original && originalUtc) return new Date(originalUtc);
  return local ? zonedLocalToUtc(local, timezone) : null;
}

const SKIPPED_TIME = "That time is skipped when the clocks change. Pick a different time.";

export async function saveEvent(
  orgId: string,
  eventId: string | null,
  timezone: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");

  const startsAt = formTime(formData, "startsAt", timezone);
  const endsAt = formTime(formData, "endsAt", timezone);
  if (!formData.get("startsAt") || !formData.get("endsAt")) {
    return { error: "Enter when the event starts and ends" };
  }
  if (!startsAt || !endsAt) {
    return { error: SKIPPED_TIME };
  }
  const text = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const capacity = text("capacity");

  const parsed = createEventSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    venue: text("venue"),
    description: text("description"),
    startsAt,
    endsAt,
    capacity: capacity === null ? null : Number(capacity),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };

  const base = `/orgs/${encodeURIComponent(orgId)}/events`;
  const { status, data } = await api(eventId ? `${base}/${encodeURIComponent(eventId)}` : base, {
    method: eventId ? "PATCH" : "POST",
    token,
    body: parsed.data,
  });
  if (status === 401) redirect("/sign-in");
  if (status !== 200 && status !== 201) return { error: errorMessage(data) };
  revalidatePath(`/orgs/${orgId}/events`);
  redirect(`/orgs/${orgId}/events`);
}

export async function saveTicketType(
  orgId: string,
  eventId: string,
  ticketTypeId: string | null,
  timezone: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");

  const priceCents = parseDollarsToCents(String(formData.get("price") ?? ""));
  if (priceCents === null) return { error: "Enter a price like 15 or 12.50" };
  const salesStartAt = formTime(formData, "salesStartAt", timezone);
  const salesEndAt = formTime(formData, "salesEndAt", timezone);
  if (
    (formData.get("salesStartAt") && !salesStartAt) ||
    (formData.get("salesEndAt") && !salesEndAt)
  ) {
    return { error: SKIPPED_TIME };
  }
  const quantity = String(formData.get("quantity") ?? "").trim();
  const studentsOnly = formData.get("studentsOnly") === "true";
  const grade = (name: string) => {
    const value = String(formData.get(name) ?? "");
    return value ? Number(value) : null;
  };

  const parsed = createTicketTypeSchema.safeParse({
    name: formData.get("name"),
    priceCents,
    quantity: quantity ? Number(quantity) : null,
    maxPerOrder: Number(formData.get("maxPerOrder")),
    salesStartAt,
    salesEndAt,
    studentsOnly,
    // Grade limits only go with students-only tickets; switching to "Anyone" clears them.
    minGrade: studentsOnly ? grade("minGrade") : null,
    maxGrade: studentsOnly ? grade("maxGrade") : null,
    requiresApproval: formData.get("requiresApproval") === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };

  const eventPath = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`;
  const base = `${eventPath}/ticket-types`;
  const { status, data } = await api(
    ticketTypeId ? `${base}/${encodeURIComponent(ticketTypeId)}` : base,
    { method: ticketTypeId ? "PATCH" : "POST", token, body: parsed.data },
  );
  if (status === 401) redirect("/sign-in");
  if (status !== 200 && status !== 201) return { error: errorMessage(data) };
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
  redirect(`/orgs/${orgId}/events/${eventId}`);
}

export async function deleteTicketType(formData: FormData) {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const orgId = String(formData.get("orgId") ?? "");
  const eventId = String(formData.get("eventId") ?? "");
  const ticketTypeId = String(formData.get("ticketTypeId") ?? "");
  const eventPath = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`;
  const { status } = await api(`${eventPath}/ticket-types/${encodeURIComponent(ticketTypeId)}`, {
    method: "DELETE",
    token,
  });
  if (status === 401) redirect("/sign-in");
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
  // 404 means it's already gone, which the refreshed list shows.
  if (status !== 204 && status !== 404) {
    redirect(`/orgs/${orgId}/events/${eventId}/tickets/${ticketTypeId}?deleteFailed=1`);
  }
  redirect(`/orgs/${orgId}/events/${eventId}`);
}
