import {
  attendeeSearchSchema,
  roleCan,
  type AttendeeSearch,
  type AttendeeCheckInFilter,
  type AttendeeWaiverFilter,
} from "@ticketapp/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../../../../lib/api";
import type { EventRecord } from "../../../../../../lib/events";
import { loadOrg } from "../../../../../../lib/org";

export const metadata: Metadata = { title: "Attendees · TicketApp" };

interface AttendeeRow {
  ticketId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  grade: number | null;
  ticketType: { id: string; name: string };
  buyerName: string;
  waiver: AttendeeWaiverFilter;
  guardianName: string | null;
  checkIn: AttendeeCheckInFilter;
  lastScanAt: string | null;
}

interface AttendeeList {
  attendees: AttendeeRow[];
  more: boolean;
  totals: {
    attendees: number;
    signed: number;
    waiting: number;
    missing: number;
    inside: number;
    left: number;
  };
  ticketTypes: { id: string; name: string }[];
}

const WAIVER_OPTIONS: [AttendeeWaiverFilter, string][] = [
  ["signed", "Signed"],
  ["waiting", "Waiting on a guardian"],
  ["missing", "Not signed"],
  ["none", "No waiver needed"],
];

const CHECK_IN_OPTIONS: [AttendeeCheckInFilter, string][] = [
  ["inside", "Inside now"],
  ["left", "Checked out"],
  ["not-arrived", "Not arrived"],
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default async function AttendeesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, eventId } = await params;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "checkin.scan")) redirect(`/orgs/${orgId}/events`);
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  // An unreadable filter in the address just shows everyone, rather than an error page.
  const parsed = attendeeSearchSchema.safeParse({
    q: one(raw.q),
    waiver: one(raw.waiver),
    checkIn: one(raw.checkIn),
    ticketTypeId: one(raw.ticketTypeId),
  });
  const filters: AttendeeSearch = parsed.success ? parsed.data : { q: undefined };
  const { q, waiver, checkIn, ticketTypeId } = filters;
  const query = new URLSearchParams(
    Object.entries(filters).filter((e): e is [string, string] => typeof e[1] === "string"),
  );

  const base = `/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`;
  const [eventRes, listRes] = await Promise.all([
    api<{ event: EventRecord }>(base, { token }),
    api<AttendeeList>(`${base}/attendees${query.size ? `?${query}` : ""}`, { token }),
  ]);
  if (eventRes.status === 404 || eventRes.status === 400) notFound();
  if (!("event" in eventRes.data)) throw new Error(`Couldn't load the event (${eventRes.status})`);
  if (!("attendees" in listRes.data)) {
    throw new Error(`Couldn't load attendees (${listRes.status})`);
  }
  const event = eventRes.data.event;
  const { attendees, more, totals, ticketTypes } = listRes.data;
  const filtered = Boolean(q || waiver || checkIn || ticketTypeId);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: org.timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  const filterLink = (f: Record<string, string>) => `${base}/attendees?${new URLSearchParams(f)}`;

  const waiverText = (a: AttendeeRow) => {
    if (a.waiver === "signed") return "Waivers signed";
    if (a.waiver === "waiting") return `Waiting on ${a.guardianName ?? "a guardian"} to sign`;
    if (a.waiver === "missing") return "Waiver not signed";
    return null;
  };
  const checkInText = (a: AttendeeRow) => {
    const at = a.lastScanAt ? time.format(new Date(a.lastScanAt)) : null;
    if (a.checkIn === "inside") return at ? `Inside since ${at}` : "Inside";
    if (a.checkIn === "left") return at ? `Checked out at ${at}` : "Checked out";
    return "Not arrived";
  };

  return (
    <main className="narrow">
      <header className="topbar">
        {/* Door staff can't open the event's settings, so they go back to the event list. */}
        {roleCan(role, "events.manage") ? (
          <a href={`/orgs/${orgId}/events/${eventId}`}>← {event.name}</a>
        ) : (
          <a href={`/orgs/${orgId}/events`}>← Events</a>
        )}
      </header>
      <p className="eyebrow">{event.name}</p>
      <h1>Attendees</h1>

      {totals.attendees > 0 && (
        <ul className="tallies">
          <li>
            <a href={filterLink({ checkIn: "inside" })}>{totals.inside} inside</a>
          </li>
          {totals.left > 0 && (
            <li>
              <a href={filterLink({ checkIn: "left" })}>{totals.left} checked out</a>
            </li>
          )}
          {totals.waiting > 0 && (
            <li>
              <a href={filterLink({ waiver: "waiting" })}>{totals.waiting} waiting on a guardian</a>
            </li>
          )}
          {totals.missing > 0 && (
            <li>
              <a href={filterLink({ waiver: "missing" })}>
                {plural(totals.missing, "waiver", "waivers")} not signed
              </a>
            </li>
          )}
          <li className="muted">of {plural(totals.attendees, "attendee", "attendees")}</li>
        </ul>
      )}

      <form className="stack-tight filters" role="search">
        <div className="search-bar">
          <input
            type="search"
            name="q"
            defaultValue={q}
            aria-label="Search attendees"
            placeholder="Attendee, email or buyer"
            maxLength={100}
          />
          <button type="submit" className="secondary">
            Search
          </button>
        </div>
        <div className="row-fields">
          <label>
            Waiver
            <select name="waiver" defaultValue={waiver ?? ""}>
              <option value="">Any</option>
              {WAIVER_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Check-in
            <select name="checkIn" defaultValue={checkIn ?? ""}>
              <option value="">Any</option>
              {CHECK_IN_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {ticketTypes.length > 1 && (
          <label>
            Ticket type
            <select name="ticketTypeId" defaultValue={ticketTypeId ?? ""}>
              <option value="">Any</option>
              {ticketTypes.map((tt) => (
                <option key={tt.id} value={tt.id}>
                  {tt.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {filtered && (
          <p className="muted">
            {more ? `More than ${attendees.length}` : plural(attendees.length, "match", "matches")}
            {" · "}
            <a href={`${base}/attendees`}>Clear filters</a>
          </p>
        )}
      </form>

      {attendees.length === 0 ? (
        <p className="muted">
          {filtered ? "Nobody matches that search." : "Nobody has a ticket yet."}
        </p>
      ) : (
        <ul className="cards">
          {attendees.map((a) => {
            const waiverLine = waiverText(a);
            return (
              <li key={a.ticketId} className="card">
                <span className="attendee-head">
                  <strong>
                    {a.lastName}, {a.firstName}
                  </strong>
                  <span className={`presence ${a.checkIn}`}>{checkInText(a)}</span>
                </span>
                <span className="muted">
                  {a.ticketType.name}
                  {a.grade !== null && ` · Grade ${a.grade}`}
                  {a.buyerName !== `${a.firstName} ${a.lastName}` && ` · Bought by ${a.buyerName}`}
                </span>
                {waiverLine && (
                  <span className={a.waiver === "signed" ? "muted" : "attention"}>
                    {waiverLine}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {more && (
        <p className="muted">
          Showing the first {attendees.length} by last name. Search or filter to find someone else.
        </p>
      )}
    </main>
  );
}
