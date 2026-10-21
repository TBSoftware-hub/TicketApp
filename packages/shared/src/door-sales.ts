import { z } from "zod";

/** Most tickets one door sale can take, so a slip of the thumb can't sell out the event. */
export const MAX_DOOR_SALE_TICKETS = 20;

/** Tickets sold at the door for cash, all under one name. */
export const doorSaleSchema = z.object({
  ticketTypeId: z.uuid("Pick a ticket type"),
  quantity: z
    .int("Enter how many tickets")
    .min(1, "Sell at least one ticket")
    .max(MAX_DOOR_SALE_TICKETS, `Sell up to ${MAX_DOOR_SALE_TICKETS} tickets at a time`),
  firstName: z.string().trim().min(1, "Enter a first name").max(80),
  lastName: z.string().trim().min(1, "Enter a last name").max(80),
  /** Optional: with one, the buyer gets their tickets by email. */
  email: z.email("Enter a valid email").trim().toLowerCase().max(254).nullable().optional(),
});
export type DoorSale = z.infer<typeof doorSaleSchema>;
