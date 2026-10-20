"use server";

import { createOrganizationSchema } from "@ticketapp/shared";
import { redirect } from "next/navigation";
import { api, errorMessage } from "../lib/api";
import { clearSessionToken, getSessionToken, setSessionToken } from "../lib/session";

export async function verifySignIn(formData: FormData) {
  const { status, data } = await api<{ sessionToken: string }>("/auth/verify", {
    method: "POST",
    body: { token: String(formData.get("token") ?? "") },
  });
  if (status !== 200 || !("sessionToken" in data)) redirect("/sign-in?expired=1");
  await setSessionToken(data.sessionToken);
  redirect("/");
}

export async function signOut() {
  const token = await getSessionToken();
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
