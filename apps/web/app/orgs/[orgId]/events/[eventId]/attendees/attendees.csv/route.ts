import { apiFile } from "../../../../../../../lib/api";
import { getSessionToken } from "../../../../../../../lib/session";

/** The search and filters the download passes on to the API; anything else is dropped. */
const PASSED_ON = ["q", "waiver", "checkIn", "ticketTypeId", "details"];

/**
 * Downloads the attendee list as a spreadsheet, narrowed by the same search and filters as the
 * page. `?details=1` adds emergency contacts and medical notes.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string; eventId: string }> },
) {
  const { orgId, eventId } = await params;
  const token = await getSessionToken();
  if (!token) return Response.redirect(new URL("/sign-in", request.url), 303);
  const asked = new URL(request.url).searchParams;
  const query = new URLSearchParams(
    PASSED_ON.flatMap((key) => {
      const value = asked.get(key);
      return value ? [[key, value]] : [];
    }),
  );
  return apiFile(
    `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/attendees.csv${query.size ? `?${query}` : ""}`,
    { token },
  );
}
