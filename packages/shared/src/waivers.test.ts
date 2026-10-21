import { describe, expect, it } from "vitest";
import { waiverFieldSchema, waiverTemplateSchema } from "./waivers";

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
