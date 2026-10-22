import { describe, expect, it } from "vitest";
import { checkoutTicketSchema, parseRosterCsv, sameName } from "./index";

describe("parseRosterCsv", () => {
  it("reads the usual columns in any order, ignoring the rest", () => {
    const csv =
      "\uFEFFLast Name,First_Name,Homeroom,Student ID,Grade Level\r\n" +
      'Lee,Sam,204, s-104 ,9th\r\n"O\'Brien, Jr.",Pat,110,S-200,Grade 12\r\n\r\nNg,Al,,S-301,K\r\n';
    expect(parseRosterCsv(csv)).toEqual({
      ok: true,
      students: [
        { studentId: "S-104", firstName: "Sam", lastName: "Lee", grade: 9 },
        { studentId: "S-200", firstName: "Pat", lastName: "O'Brien, Jr.", grade: 12 },
        { studentId: "S-301", firstName: "Al", lastName: "Ng", grade: null },
      ],
    });
  });

  it("doesn't need a grade column", () => {
    const parsed = parseRosterCsv("id,first,last\n1,Sam,Lee");
    expect(parsed).toEqual({
      ok: true,
      students: [{ studentId: "1", firstName: "Sam", lastName: "Lee", grade: null }],
    });
  });

  it("says which headings it couldn't find", () => {
    const parsed = parseRosterCsv("Name,Grade\nSam Lee,9\n");
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems[0]).toContain("student id, first name, last name");
    expect(parseRosterCsv("")).toEqual({ ok: false, problems: ["The file is empty"] });
    expect(parseRosterCsv("id,first,last\n")).toEqual({
      ok: false,
      problems: ["The file has headings but no students"],
    });
  });

  it("lists every bad row by its line in the file", () => {
    const csv = [
      "Student ID,First Name,Last Name,Grade",
      "S1,Sam,Lee,9",
      ',Jo,"Park',
      'with a line break",10',
      "s1,Al,Ng,13",
      "S2,,Ng,",
    ].join("\n");
    expect(parseRosterCsv(csv)).toEqual({
      ok: false,
      problems: [
        "Line 3: no student ID",
        "Line 5: student ID S1 is also on line 2",
        'Line 5: "13" isn\'t a grade from 1 to 12',
        "Line 6: needs a first and last name",
      ],
    });
  });

  it("refuses a quote that never closes, rather than losing the rows after it", () => {
    const csv = 'id,first,last,notes\nS1,Sam,Lee,"note\nS2,Jo,Park,other\n';
    expect(parseRosterCsv(csv)).toEqual({
      ok: false,
      problems: ["Line 2: a quote mark opens here and never closes"],
    });
  });

  it("refuses a quote in the middle of a value, which would swallow the next row", () => {
    const csv = 'id,first,last,notes\nS1,Sam,Lee,some "note\nS2,Jo,Park,other"\n';
    expect(parseRosterCsv(csv)).toEqual({
      ok: false,
      problems: [
        'Line 2: a quote mark in the middle of a value. Put quotes around the whole value and double any quote inside it ("")',
      ],
    });
    expect(parseRosterCsv('id,first,last\nS1,"Sam"x,Lee\n').ok).toBe(false);
    // Quotes done properly are fine.
    expect(parseRosterCsv('id,first,last\nS1,"Sam ""Red""",Lee\n')).toEqual({
      ok: true,
      students: [{ studentId: "S1", firstName: 'Sam "Red"', lastName: "Lee", grade: null }],
    });
  });

  it("stops listing problems after twenty", () => {
    const rows = Array.from({ length: 25 }, (_, i) => `S${i},Sam,,9`);
    const parsed = parseRosterCsv(["id,first,last,grade", ...rows].join("\n"));
    expect(!parsed.ok && parsed.problems).toHaveLength(21);
    expect(!parsed.ok && parsed.problems.at(-1)).toBe("…and 5 more");
  });
});

describe("sameName", () => {
  it("ignores case, accents and punctuation", () => {
    expect(sameName("O'Brien", "obrien")).toBe(true);
    expect(sameName("Muñoz", "MUNOZ")).toBe(true);
    expect(sameName("Smith-Jones", "Smith Jones")).toBe(true);
    expect(sameName("Lee", "Li")).toBe(false);
    expect(sameName("", "")).toBe(false);
  });
});

describe("checkoutTicketSchema studentId", () => {
  const base = {
    ticketTypeId: "01a1562f-061b-72dd-a3fe-40770af4ed8f",
    firstName: "Sam",
    lastName: "Lee",
  };
  it("is matched trimmed and upper-cased, and blank means none", () => {
    expect(checkoutTicketSchema.parse({ ...base, studentId: " s-104 " }).studentId).toBe("S-104");
    expect(checkoutTicketSchema.parse({ ...base, studentId: "  " }).studentId).toBeNull();
    expect(checkoutTicketSchema.parse(base).studentId).toBeUndefined();
  });
});
