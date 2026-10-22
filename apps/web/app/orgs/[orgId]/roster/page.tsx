import { roleCan } from "@ticketapp/shared";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { api } from "../../../../lib/api";
import { loadOrg } from "../../../../lib/org";
import { removeRoster } from "../../../actions";
import { RosterForm } from "./roster-form";

export const metadata: Metadata = { title: "Student roster · TicketApp" };

interface RosterSummary {
  importedAt: string;
  students: number;
  grades: { grade: number | null; students: number }[];
}

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export default async function RosterPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { orgId } = await params;
  const { error } = await searchParams;
  const { token, org, role } = await loadOrg(orgId);
  if (!roleCan(role, "events.manage")) redirect(`/orgs/${orgId}/events`);
  const { status, data } = await api<{ roster: RosterSummary | null }>(
    `/orgs/${encodeURIComponent(orgId)}/roster`,
    { token },
  );
  if (!("roster" in data)) throw new Error(`Couldn't load the roster (${status})`);
  const { roster } = data;
  const date = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: org.timezone,
  });

  return (
    <main>
      <header className="topbar">
        <a href="/">← All organizations</a>
      </header>
      <p className="eyebrow">{org.name}</p>
      <h1>Student roster</h1>
      <p>
        With a roster on file, students-only tickets ask for a student ID, and checkout only sells
        them to students on the roster, in the grade it lists. Without one, buyers say who&apos;s a
        student and pick their grade.
      </p>

      <section className="card stack-tight">
        {roster ? (
          <>
            <strong>{plural(roster.students, "student", "students")} on file</strong>
            <span className="muted">Imported {date.format(new Date(roster.importedAt))}</span>
            <ul className="tallies">
              {roster.grades.map((g) => (
                <li key={g.grade ?? "none"}>
                  <strong>{g.students.toLocaleString("en-US")}</strong>{" "}
                  <span className="muted">
                    {g.grade === null ? "No grade listed" : `Grade ${g.grade}`}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <strong>No roster yet</strong>
        )}
      </section>

      <section className="stack">
        <h2>{roster ? "Replace the roster" : "Import a roster"}</h2>
        <p className="muted hint">
          Export a CSV from your student information system. The first row needs headings for
          student ID, first name and last name, and grade if you have it; other columns are ignored.
          Each import replaces the whole roster, so students who&apos;ve left drop off.
        </p>
        <pre className="sample">
          {"Student ID,First Name,Last Name,Grade\n104233,Sam,Lee,11\n104871,Jo,Park,12"}
        </pre>
        <RosterForm orgId={orgId} replacing={roster !== null} />
      </section>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {roster && (
        <section className="links">
          <form action={removeRoster}>
            <input type="hidden" name="orgId" value={orgId} />
            <button type="submit" className="link">
              Remove the roster
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
