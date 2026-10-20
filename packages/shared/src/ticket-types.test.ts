import { describe, expect, it } from "vitest";
import {
  checkEligibility,
  createTicketTypeSchema,
  gradeRangeLabel,
  parseDollarsToCents,
  updateTicketTypeSchema,
} from "./index";

describe("parseDollarsToCents", () => {
  it.each([
    ["12", 1200],
    ["12.5", 1250],
    ["12.05", 1205],
    ["$1,012.50", 101250],
    ["0", 0],
    [" 7.00 ", 700],
  ])("reads %j as %i cents", (input, cents) => {
    expect(parseDollarsToCents(input)).toBe(cents);
  });

  it.each(["", "abc", "12.345", "-5", "12,50", "1.2.3", "$"])("rejects %j", (input) => {
    expect(parseDollarsToCents(input)).toBeNull();
  });
});

describe("ticket type schemas", () => {
  const base = { name: "General", priceCents: 1500, maxPerOrder: 10 };

  it("accepts a free ticket with no limit or sale window", () => {
    expect(createTicketTypeSchema.safeParse({ ...base, priceCents: 0 }).success).toBe(true);
  });

  it("rejects fractional cents and negative prices", () => {
    expect(createTicketTypeSchema.safeParse({ ...base, priceCents: 12.5 }).success).toBe(false);
    expect(createTicketTypeSchema.safeParse({ ...base, priceCents: -1 }).success).toBe(false);
  });

  it("requires sales to end after they start", () => {
    const window = { salesStartAt: "2026-11-01T00:00:00Z", salesEndAt: "2026-10-01T00:00:00Z" };
    expect(createTicketTypeSchema.safeParse({ ...base, ...window }).success).toBe(false);
    expect(updateTicketTypeSchema.safeParse(window).success).toBe(false);
  });
});

describe("eligibility rules", () => {
  const base = { name: "Prom", priceCents: 4000, maxPerOrder: 2 };

  it("only allows grade limits on students-only tickets", () => {
    expect(createTicketTypeSchema.safeParse({ ...base, minGrade: 11 }).success).toBe(false);
    expect(
      createTicketTypeSchema.safeParse({ ...base, studentsOnly: true, minGrade: 11, maxGrade: 12 })
        .success,
    ).toBe(true);
  });

  it("rejects an upside-down or out-of-range grade range", () => {
    const students = { ...base, studentsOnly: true };
    expect(
      createTicketTypeSchema.safeParse({ ...students, minGrade: 12, maxGrade: 9 }).success,
    ).toBe(false);
    expect(createTicketTypeSchema.safeParse({ ...students, maxGrade: 13 }).success).toBe(false);
  });
});

describe("checkEligibility", () => {
  const open = { studentsOnly: false, minGrade: null, maxGrade: null, requiresApproval: false };
  const upperclass = { ...open, studentsOnly: true, minGrade: 11, maxGrade: 12 };

  it("lets anyone buy an open ticket", () => {
    expect(checkEligibility(open, { isStudent: false, grade: null })).toEqual({
      eligible: true,
      needsApproval: false,
    });
  });

  it("turns away non-students from a students-only ticket", () => {
    expect(checkEligibility(upperclass, { isStudent: false, grade: null })).toMatchObject({
      eligible: false,
      reason: "These tickets are for students only",
    });
  });

  it("checks the grade range, inclusive at both ends", () => {
    expect(checkEligibility(upperclass, { isStudent: true, grade: 11 }).eligible).toBe(true);
    expect(checkEligibility(upperclass, { isStudent: true, grade: 12 }).eligible).toBe(true);
    expect(checkEligibility(upperclass, { isStudent: true, grade: 10 })).toMatchObject({
      eligible: false,
      reason: "These tickets are for grades 11–12",
    });
    expect(checkEligibility(upperclass, { isStudent: true, grade: null })).toMatchObject({
      eligible: false,
    });
  });

  it("flags guest passes for staff approval", () => {
    expect(
      checkEligibility({ ...open, requiresApproval: true }, { isStudent: false, grade: null }),
    ).toEqual({ eligible: true, needsApproval: true });
  });

  it("labels grade ranges", () => {
    expect(gradeRangeLabel(9, 12)).toBe("grades 9–12");
    expect(gradeRangeLabel(12, 12)).toBe("12th grade");
    expect(gradeRangeLabel(11, 11)).toBe("11th grade");
    expect(gradeRangeLabel(1, 1)).toBe("1st grade");
    expect(gradeRangeLabel(9, null)).toBe("grades 9 and up");
    expect(gradeRangeLabel(null, 8)).toBe("grades 8 and below");
  });
});
