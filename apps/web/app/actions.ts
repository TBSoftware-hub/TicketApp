"use server";

import {
  createCompSchema,
  doorSaleSchema,
  formatCents,
  createEventSchema,
  createInvitationSchema,
  createOrganizationSchema,
  createPromoCodeSchema,
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
  const { status, data } = await api(
    `${eventPath}/ticket-types/${encodeURIComponent(ticketTypeId)}`,
    { method: "DELETE", token },
  );
  if (status === 401) redirect("/sign-in");
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
  // 404 means it's already gone, which the refreshed list shows.
  if (status !== 204 && status !== 404) {
    redirect(
      `/orgs/${orgId}/events/${eventId}/tickets/${ticketTypeId}?error=${encodeURIComponent(errorMessage(data))}`,
    );
  }
  redirect(`/orgs/${orgId}/events/${eventId}`);
}

export async function setEventStatus(formData: FormData) {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const orgId = String(formData.get("orgId") ?? "");
  const eventId = String(formData.get("eventId") ?? "");
  const status = String(formData.get("status") ?? "");
  const eventPath = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`;
  const { status: code, data } = await api(`${eventPath}/status`, {
    method: "POST",
    token,
    body: { status },
  });
  if (code === 401) redirect("/sign-in");
  revalidatePath(`/orgs/${orgId}/events`);
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
  if (code !== 200) {
    redirect(
      `/orgs/${orgId}/events/${eventId}?statusError=${encodeURIComponent(errorMessage(data))}`,
    );
  }
  redirect(`/orgs/${orgId}/events/${eventId}`);
}

export interface CreatedState extends FormState {
  /** Set after a success, so the form can clear itself and say what happened. */
  done?: { id: string; label: string };
}

export async function createPromoCode(
  orgId: string,
  eventId: string,
  timezone: string,
  _prev: CreatedState,
  formData: FormData,
): Promise<CreatedState> {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");

  const discountType = String(formData.get("discountType") ?? "");
  const rawValue = String(formData.get("discountValue") ?? "").trim();
  const discountValue =
    discountType === "AMOUNT"
      ? parseDollarsToCents(rawValue)
      : /^\d+$/.test(rawValue)
        ? Number(rawValue)
        : null;
  if (discountValue === null) {
    return {
      error: discountType === "AMOUNT" ? "Enter an amount like 5 or 2.50" : "Enter a whole percent",
    };
  }
  const validFrom = formTime(formData, "validFrom", timezone);
  const validUntil = formTime(formData, "validUntil", timezone);
  if ((formData.get("validFrom") && !validFrom) || (formData.get("validUntil") && !validUntil)) {
    return { error: SKIPPED_TIME };
  }
  const maxUses = String(formData.get("maxUses") ?? "").trim();

  const parsed = createPromoCodeSchema.safeParse({
    code: formData.get("code"),
    discountType,
    discountValue,
    maxUses: maxUses ? Number(maxUses) : null,
    validFrom,
    validUntil,
    ticketTypeIds: formData.getAll("ticketTypeIds").map(String),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };

  const path = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/promo-codes`;
  const { status, data } = await api(path, { method: "POST", token, body: parsed.data });
  if (status === 401) redirect("/sign-in");
  if (status !== 201) return { error: errorMessage(data) };
  revalidatePath(`/orgs/${orgId}/events/${eventId}/promo-codes`);
  const { promoCode } = data as { promoCode: { id: string } };
  return { done: { id: promoCode.id, label: parsed.data.code } };
}

export async function updatePromoCode(formData: FormData) {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const orgId = String(formData.get("orgId") ?? "");
  const eventId = String(formData.get("eventId") ?? "");
  const promoCodeId = String(formData.get("promoCodeId") ?? "");
  const intent = String(formData.get("intent") ?? "");
  const page = `/orgs/${orgId}/events/${eventId}/promo-codes`;
  const path = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/promo-codes/${encodeURIComponent(promoCodeId)}`;
  const { status, data } =
    intent === "delete"
      ? await api(path, { method: "DELETE", token })
      : await api(path, { method: "PATCH", token, body: { active: intent === "activate" } });
  if (status === 401) redirect("/sign-in");
  revalidatePath(page);
  // 404 means it's already gone, which the refreshed list shows.
  if (status !== 200 && status !== 204 && status !== 404) {
    redirect(`${page}?error=${encodeURIComponent(errorMessage(data))}`);
  }
  redirect(page);
}

export async function issueComp(
  orgId: string,
  eventId: string,
  _prev: CreatedState,
  formData: FormData,
): Promise<CreatedState> {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const note = String(formData.get("note") ?? "").trim();
  const parsed = createCompSchema.safeParse({
    ticketTypeId: formData.get("ticketTypeId"),
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    email: formData.get("email"),
    note: note || null,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };

  const path = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/comps`;
  const { status, data } = await api(path, { method: "POST", token, body: parsed.data });
  if (status === 401) redirect("/sign-in");
  if (status !== 201) return { error: errorMessage(data) };
  revalidatePath(`/orgs/${orgId}/events/${eventId}/comps`);
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
  const { comp } = data as { comp: { id: string } };
  return { done: { id: comp.id, label: `${parsed.data.firstName} ${parsed.data.lastName}` } };
}

export async function recordDoorSale(
  orgId: string,
  eventId: string,
  _prev: CreatedState,
  formData: FormData,
): Promise<CreatedState> {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const email = String(formData.get("email") ?? "").trim();
  const parsed = doorSaleSchema.safeParse({
    saleKey: formData.get("saleKey"),
    ticketTypeId: formData.get("ticketTypeId"),
    quantity: Number(formData.get("quantity")),
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    email: email || null,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };

  const page = `/orgs/${orgId}/events/${eventId}/door`;
  const path = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/door-sales`;
  const { status, data } = await api(path, { method: "POST", token, body: parsed.data });
  if (status === 401) redirect("/sign-in");
  // A sale sent again after a lost response comes back as 200 with the original sale.
  if (status !== 201 && status !== 200) return { error: errorMessage(data) };
  revalidatePath(page);
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
  const { sale } = data as { sale: { id: string; totalCents: number } };
  const { quantity, firstName, lastName } = parsed.data;
  return {
    done: {
      id: sale.id,
      label: `${quantity === 1 ? "1 ticket" : `${quantity} tickets`} to ${firstName} ${lastName}. Collect ${formatCents(sale.totalCents)}`,
    },
  };
}

export async function voidComp(formData: FormData) {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const orgId = String(formData.get("orgId") ?? "");
  const eventId = String(formData.get("eventId") ?? "");
  const orderId = String(formData.get("orderId") ?? "");
  const page = `/orgs/${orgId}/events/${eventId}/comps`;
  const path = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/comps/${encodeURIComponent(orderId)}/void`;
  const { status, data } = await api(path, { method: "POST", token });
  if (status === 401) redirect("/sign-in");
  revalidatePath(page);
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
  if (status !== 200) redirect(`${page}?error=${encodeURIComponent(errorMessage(data))}`);
  redirect(page);
}

/** Cancels an order from the dashboard, refunding the card if it was paid for. */
export async function cancelOrder(formData: FormData) {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const orgId = String(formData.get("orgId") ?? "");
  const eventId = String(formData.get("eventId") ?? "");
  const orderId = String(formData.get("orderId") ?? "");
  const q = String(formData.get("q") ?? "");
  const page = `/orgs/${orgId}/events/${eventId}/orders`;
  const back = (params: Record<string, string>) => {
    const query = new URLSearchParams({ ...(q ? { q } : {}), ...params }).toString();
    return query ? `${page}?${query}` : page;
  };
  const path = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/orders/${encodeURIComponent(orderId)}/cancel`;
  const { status, data } = await api(path, { method: "POST", token });
  if (status === 401) redirect("/sign-in");
  revalidatePath(page);
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
  if (status !== 200) redirect(back({ error: errorMessage(data) }));
  redirect(back({}));
}

/** Sends an owner to Stripe's hosted setup (or their Stripe dashboard) for the organization. */
export async function openStripe(formData: FormData) {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const orgId = String(formData.get("orgId") ?? "");
  const target = formData.get("target") === "dashboard" ? "dashboard" : "onboarding";
  const { status, data } = await api<{ url: string }>(
    `/orgs/${encodeURIComponent(orgId)}/payments/${target}`,
    { method: "POST", token },
  );
  if (status === 401) redirect("/sign-in");
  if (status !== 200 || !("url" in data)) {
    redirect(`/orgs/${orgId}/payouts?error=${encodeURIComponent(errorMessage(data))}`);
  }
  redirect(data.url);
}

export async function saveFeeSettings(formData: FormData) {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const orgId = String(formData.get("orgId") ?? "");
  const page = `/orgs/${orgId}/payouts`;
  const { status, data } = await api(`/orgs/${encodeURIComponent(orgId)}/payments/settings`, {
    method: "PUT",
    token,
    body: {
      cardFeePaidBy: formData.get("cardFeePaidBy"),
      serviceFeePaidBy: formData.get("serviceFeePaidBy"),
    },
  });
  if (status === 401) redirect("/sign-in");
  if (status !== 200) redirect(`${page}?error=${encodeURIComponent(errorMessage(data))}`);
  redirect(`${page}?saved=1`);
}
