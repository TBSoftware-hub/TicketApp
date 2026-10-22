import { apiFile } from "../../../../../../../lib/api";
import { getSessionToken } from "../../../../../../../lib/session";

/**
 * Downloads who signed what for the event as a spreadsheet. `?details=1` adds emergency contacts
 * and medical notes.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string; eventId: string }> },
) {
  const { orgId, eventId } = await params;
  const token = await getSessionToken();
  if (!token) return Response.redirect(new URL("/sign-in", request.url), 303);
  const details = new URL(request.url).searchParams.get("details") === "1";
  return apiFile(
    `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/waivers.csv${details ? "?details=1" : ""}`,
    { token },
  );
}
