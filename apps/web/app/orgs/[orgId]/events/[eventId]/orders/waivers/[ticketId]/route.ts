import { apiFile } from "../../../../../../../../lib/api";
import { getSessionToken } from "../../../../../../../../lib/session";

/** Downloads a ticket's signed waivers, with their audit trail, as a PDF. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string; eventId: string; ticketId: string }> },
) {
  const { orgId, eventId, ticketId } = await params;
  const token = await getSessionToken();
  if (!token) return Response.redirect(new URL("/sign-in", _request.url), 303);
  return apiFile(
    `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/tickets/${encodeURIComponent(ticketId)}/waivers.pdf`,
    { token },
  );
}
