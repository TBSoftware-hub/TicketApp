import { apiFile } from "../../../../../../../lib/api";
import { getSessionToken } from "../../../../../../../lib/session";

/** Downloads every signed waiver for the event as one PDF, with a cover page listing everyone. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string; eventId: string }> },
) {
  const { orgId, eventId } = await params;
  const token = await getSessionToken();
  if (!token) return Response.redirect(new URL("/sign-in", request.url), 303);
  return apiFile(
    `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/waivers.pdf`,
    { token },
  );
}
