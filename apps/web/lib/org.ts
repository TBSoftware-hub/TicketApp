import type { Role } from "@ticketapp/shared";
import { notFound, redirect } from "next/navigation";
import { api } from "./api";
import { getSessionToken } from "./session";

export interface Org {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

/** Loads an organization for a dashboard page, sending the visitor away if they can't see it. */
export async function loadOrg(orgId: string) {
  const token = await getSessionToken();
  if (!token) redirect("/sign-in");
  const { status, data } = await api<{ organization: Org; role: Role }>(
    `/orgs/${encodeURIComponent(orgId)}`,
    { token },
  );
  if (status === 401) redirect("/sign-in");
  if (status === 404 || status === 400) notFound();
  if (!("organization" in data)) throw new Error(`Couldn't load the organization (${status})`);
  return { token, org: data.organization, role: data.role };
}
