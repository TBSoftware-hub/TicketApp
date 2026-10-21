import { describe, expect, it } from "vitest";
import {
  checkWaiverAnswers,
  signatureMatches,
  waiverFieldSchema,
  waiverTemplateSchema,
  type WaiverField,
} from "./waivers";

const base = { title: "Field Trip Waiver", body: "I agree.", requiresGuardianForMinors: true };

describe("waiver templates", () => {
  it("accepts a waiver with no questions, and trims what was typed", () => {
    expect(waiverTemplateSchema.parse({ ...base, title: "  Trip  ", fields: [] })).toEqual({
      ...base,
      title: "Trip",
      fields: [],
    });
  });

  it("keeps choices only on pick-one questions", () => {
    const text = waiverFieldSchema.parse({
      id: "a1",
      label: "Allergies",
      type: "TEXT",
      required: false,
      help: "",
      options: ["left over"],
    });
    expect(text).toEqual({
      id: "a1",
      label: "Allergies",
      type: "TEXT",
      required: false,
      help: null,
    });
    const choice = waiverFieldSchema.parse({
      id: "b2",
      label: "T-shirt size",
      type: "CHOICE",
      required: true,
      options: [" S ", "M"],
    });
    expect(choice.options).toEqual(["S", "M"]);
  });

  it("needs two different choices for a pick-one question", () => {
    const field = { id: "c3", label: "Size", type: "CHOICE", required: true };
    expect(waiverFieldSchema.safeParse({ ...field, options: ["S"] }).success).toBe(false);
    expect(waiverFieldSchema.safeParse({ ...field, options: ["S", "S"] }).success).toBe(false);
    expect(waiverFieldSchema.safeParse({ ...field }).success).toBe(false);
  });

  it("refuses blank labels, odd IDs, repeated IDs and too many questions", () => {
    const q = (id: string) => ({ id, label: "Q", type: "TEXT", required: false });
    expect(waiverFieldSchema.safeParse({ ...q("a"), label: " " }).success).toBe(false);
    expect(waiverFieldSchema.safeParse(q("Has Space")).success).toBe(false);
    expect(waiverTemplateSchema.safeParse({ ...base, fields: [q("a"), q("a")] }).success).toBe(
      false,
    );
    const many = Array.from({ length: 31 }, (_, i) => q(`f${i}`));
    expect(waiverTemplateSchema.safeParse({ ...base, fields: many }).success).toBe(false);
  });

  it("needs a title and some wording", () => {
    expect(waiverTemplateSchema.safeParse({ ...base, title: "x", fields: [] }).success).toBe(false);
    expect(waiverTemplateSchema.safeParse({ ...base, body: "  ", fields: [] }).success).toBe(false);
  });
});

describe("waiver answers", () => {
  const fields: WaiverField[] = [
    { id: "allergy", label: "Allergies", type: "LONG_TEXT", required: false, help: null },
    { id: "size", label: "Size", type: "CHOICE", required: true, help: null, options: ["S", "M"] },
    { id: "photo", label: "Photos are fine", type: "CHECKBOX", required: false, help: null },
    { id: "rules", label: "I read the rules", type: "CHECKBOX", required: true, help: null },
    { id: "dob", label: "Date of birth", type: "DATE", required: false, help: null },
    { id: "mail", label: "Parent email", type: "EMAIL", required: false, help: null },
  ];

  it("keeps trimmed answers to the waiver's own questions", () => {
    expect(
      checkWaiverAnswers(fields, {
        allergy: "  peanuts ",
        size: "M",
        rules: true,
        dob: "2010-02-03",
        extra: "dropped",
      }),
    ).toEqual({
      answers: { allergy: "peanuts", size: "M", photo: false, rules: true, dob: "2010-02-03" },
    });
  });

  it("names the question that's missing or wrong", () => {
    const ok = { size: "S", rules: true };
    expect(checkWaiverAnswers(fields, { rules: true })).toEqual({ problem: "Answer “Size”" });
    expect(checkWaiverAnswers(fields, { size: "S", rules: false })).toEqual({
      problem: "Tick “I read the rules”",
    });
    expect(checkWaiverAnswers(fields, { ...ok, size: "XL" })).toEqual({
      problem: "Pick one of the choices for “Size”",
    });
    expect(checkWaiverAnswers(fields, { ...ok, dob: "Feb 3" })).toEqual({
      problem: "Enter a date for “Date of birth”",
    });
    expect(checkWaiverAnswers(fields, { ...ok, mail: "nope" })).toEqual({
      problem: "Enter a valid email for “Parent email”",
    });
    expect(checkWaiverAnswers(fields, { ...ok, allergy: "x".repeat(5001) })).toEqual({
      problem: "Keep “Allergies” under 5000 characters",
    });
    // A checkbox only counts when it's really ticked.
    expect(checkWaiverAnswers(fields, { size: "S", rules: "true" })).toEqual({
      problem: "Tick “I read the rules”",
    });
  });

  it("matches a typed signature to the signer's name", () => {
    expect(signatureMatches("  jo   PARK ", "Jo Park")).toBe(true);
    expect(signatureMatches("Jo P", "Jo Park")).toBe(false);
    expect(signatureMatches(" ", " ")).toBe(false);
  });
});
