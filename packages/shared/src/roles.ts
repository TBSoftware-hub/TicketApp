import { z } from "zod";

export const roleSchema = z.enum(["OWNER", "ADMIN", "DOOR_STAFF", "VIEWER"]);
export type Role = z.infer<typeof roleSchema>;

export type Permission =
  "org.view" | "org.manage" | "members.manage" | "events.manage" | "checkin.scan" | "reports.view";

const PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: [
    "org.view",
    "org.manage",
    "members.manage",
    "events.manage",
    "checkin.scan",
    "reports.view",
  ],
  ADMIN: ["org.view", "members.manage", "events.manage", "checkin.scan", "reports.view"],
  DOOR_STAFF: ["org.view", "checkin.scan"],
  VIEWER: ["org.view", "reports.view"],
};

/** Single source of truth for what each staff role may do; the API enforces it, apps use it to hide UI. */
export function roleCan(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role].includes(permission);
}
