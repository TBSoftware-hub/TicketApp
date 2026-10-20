"use server";

import { createInvitationSchema, createOrganizationSchema } from "@ticketapp/shared";
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
  // A 404 means it was already accepted or revoked; either way the refreshed list shows the truth.
  revalidatePath(`/orgs/${orgId}/team`);
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
