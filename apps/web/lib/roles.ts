import type { Role } from "@ticketapp/shared";

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  DOOR_STAFF: "Door staff",
  VIEWER: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  OWNER: "Everything, including billing and other owners",
  ADMIN: "Runs events, the team and reports",
  DOOR_STAFF: "Scans tickets at the door",
  VIEWER: "Sees reports only",
};
