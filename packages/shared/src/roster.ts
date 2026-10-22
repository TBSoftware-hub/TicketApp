import { z } from "zod";
import { MAX_GRADE, MIN_GRADE } from "./ticket-types";

/** Big enough for a large high school several times over. */
export const MAX_ROSTER_STUDENTS = 20_000;
/** Plenty for that many students, and under Vercel's 4.5 MB cap on what a page can upload. */
export const MAX_ROSTER_BYTES = 3 * 1024 * 1024;
export const MAX_STUDENT_ID_LENGTH = 40;
/** How many bad rows an import lists before it stops counting. */
const MAX_PROBLEMS = 20;

export interface RosterStudentRow {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | null;
}

export type RosterParse =
  { ok: true; students: RosterStudentRow[] } | { ok: false; problems: string[] };

/** Student IDs are matched trimmed and upper-cased, so "s-104" and "S-104 " are the same. */
export function normalizeStudentId(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Whether two spellings of a name are the same person's, ignoring case, accents, spaces and
 * punctuation, so "O'Brien" matches "obrien" and "Muñoz" matches "Munoz".
 */
export function sameName(a: string, b: string): boolean {
  const plain = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  const left = plain(a);
  return left !== "" && left === plain(b);
}

/** The headings each column goes by in the exports schools tend to have. */
const COLUMNS = {
  studentId: ["student id", "studentid", "student number", "student no", "student #", "id"],
  firstName: ["first name", "firstname", "first", "given name", "student first name"],
  lastName: ["last name", "lastname", "last", "surname", "family name", "student last name"],
  grade: ["grade", "grade level", "gradelevel", "current grade"],
} as const;
type Column = keyof typeof COLUMNS;

const heading = (s: string) => s.trim().toLowerCase().replace(/[_.]+/g, " ").replace(/\s+/g, " ");

/**
 * Splits CSV text into rows, following the quoting rules spreadsheets use. Quotes anywhere else
 * are refused with the line they're on, since a stray one would run the rows after it into a cell.
 */
function csvRows(text: string): { line: number; cells: string[] }[] | { problem: string } {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let value = "";
  let quoted = false;
  // Just past a quoted value's closing quote, where only a comma or line break may follow.
  let closed = false;
  let line = 1;
  let rowLine = 1;
  let quoteLine = 1;
  const endRow = () => {
    cells.push(value);
    if (cells.some((c) => c.trim() !== "")) rows.push({ line: rowLine, cells });
    cells = [];
    value = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else {
        if (ch === "\n") line++;
        value += ch;
      }
    } else if (ch === ",") {
      cells.push(value);
      value = "";
      closed = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      closed = false;
      line++;
      rowLine = line;
    } else if (closed || ch === '"') {
      // A quote may only open a value, and nothing may follow the quote that closes one.
      if (ch === '"' && !closed && value === "") {
        quoted = true;
        quoteLine = line;
      } else {
        return {
          problem: `Line ${line}: a quote mark in the middle of a value. Put quotes around the whole value and double any quote inside it ("")`,
        };
      }
    } else {
      value += ch;
    }
  }
  if (quoted) return { problem: `Line ${quoteLine}: a quote mark opens here and never closes` };
  if (value !== "" || cells.length > 0) endRow();
  return rows;
}

/** "9", "09", "9th", "Grade 9"; blank, K and pre-K mean no grade on file. */
function parseGrade(value: string): number | null | "bad" {
  const v = value.trim().toLowerCase();
  if (v === "" || ["k", "kg", "kindergarten", "pk", "prek", "pre-k", "tk"].includes(v)) {
    return null;
  }
  const match = /^(?:grade\s*)?(\d{1,2})(?:st|nd|rd|th)?(?:\s*grade)?$/.exec(v);
  if (!match) return "bad";
  const grade = Number(match[1]);
  return grade >= MIN_GRADE && grade <= MAX_GRADE ? grade : "bad";
}

/**
 * Reads a roster CSV with a heading row naming at least the student ID, first name and last
 * name columns; a grade column is optional and other columns are ignored. Either every row is
 * good and the whole roster comes back, or nothing does and the problems are listed by line, so
 * a bad export never half-replaces the roster.
 */
export function parseRosterCsv(text: string): RosterParse {
  const rows = csvRows(text.replace(/^\uFEFF/, ""));
  if ("problem" in rows) return { ok: false, problems: [rows.problem] };
  const [head, ...body] = rows;
  if (!head) return { ok: false, problems: ["The file is empty"] };

  const names = head.cells.map(heading);
  const index = {} as Record<Column, number>;
  const missing: string[] = [];
  for (const [column, aliases] of Object.entries(COLUMNS) as [Column, readonly string[]][]) {
    index[column] = names.findIndex((n) => aliases.includes(n));
    if (index[column] === -1 && column !== "grade") missing.push(aliases[0]!);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      problems: [
        `The first row needs column headings for student ID, first name and last name. Couldn't find: ${missing.join(", ")}`,
      ],
    };
  }
  if (body.length === 0) return { ok: false, problems: ["The file has headings but no students"] };
  if (body.length > MAX_ROSTER_STUDENTS) {
    return {
      ok: false,
      problems: [`A roster can list up to ${MAX_ROSTER_STUDENTS.toLocaleString("en-US")} students`],
    };
  }

  const problems: string[] = [];
  let more = 0;
  const problem = (line: number, message: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(`Line ${line}: ${message}`);
    else more++;
  };
  const seen = new Map<string, number>();
  const students: RosterStudentRow[] = [];
  for (const { line, cells } of body) {
    const cell = (column: Column) => (index[column] === -1 ? "" : (cells[index[column]] ?? ""));
    const studentId = normalizeStudentId(cell("studentId"));
    const firstName = cell("firstName").trim();
    const lastName = cell("lastName").trim();
    const grade = parseGrade(cell("grade"));
    if (!studentId) problem(line, "no student ID");
    else if (studentId.length > MAX_STUDENT_ID_LENGTH) {
      problem(line, `student IDs can be up to ${MAX_STUDENT_ID_LENGTH} characters`);
    } else if (seen.has(studentId)) {
      problem(line, `student ID ${studentId} is also on line ${seen.get(studentId)}`);
    } else seen.set(studentId, line);
    if (!firstName || !lastName) problem(line, "needs a first and last name");
    else if (firstName.length > 80 || lastName.length > 80) {
      problem(line, "names can be up to 80 characters");
    }
    if (grade === "bad") {
      problem(line, `"${cell("grade").trim()}" isn't a grade from ${MIN_GRADE} to ${MAX_GRADE}`);
    }
    if (grade !== "bad") students.push({ studentId, firstName, lastName, grade });
  }
  if (more > 0) problems.push(`…and ${more} more`);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, students };
}

export const rosterImportSchema = z.object({
  csv: z
    .string()
    .min(1, "Choose a CSV file")
    // Measured in UTF-8 bytes, as the file was, since names in other scripts take several each.
    .refine((csv) => new TextEncoder().encode(csv).length <= MAX_ROSTER_BYTES, {
      message: "The file is too big. A roster CSV should be under 3 MB",
    }),
});
export type RosterImport = z.infer<typeof rosterImportSchema>;
