import { z } from "zod";

/** Direction of a door scan. Check-outs trigger the guardian "left the event" text. */
export const scanDirectionSchema = z.enum(["in", "out"]);
export type ScanDirection = z.infer<typeof scanDirectionSchema>;

/** What the door app shows after a scan. */
export const scanOutcomeSchema = z.enum([
  "admitted",
  "checked_out",
  "already_inside",
  "not_inside",
  "waiver_missing",
  "invalid_ticket",
]);
export type ScanOutcome = z.infer<typeof scanOutcomeSchema>;

export function isAdmittingOutcome(outcome: ScanOutcome): boolean {
  return outcome === "admitted" || outcome === "checked_out";
}
