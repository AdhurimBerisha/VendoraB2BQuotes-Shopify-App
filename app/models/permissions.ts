import { ForbiddenError } from "../lib/errors";
import type { Actor, Role } from "./actor";

// What each Vendora role may do (D-9). Pure, so pages can hide buttons with the same rules;
// the server check is what counts.

type Permission =
  | "quote.view"
  | "quote.create"
  | "quote.edit"
  | "quote.submit"
  | "quote.approve"
  | "quote.send"
  | "quote.cancel.any"
  | "quote.cancel.own"
  | "quote.assign"
  | "import.run"
  | "settings.manage"
  | "team.manage"
  | "attention.resolve"
  | "jobs.retry"
  | "export.all";

const ROLES: Role[] = ["OWNER", "MANAGER", "REP", "VIEWER"];

const MANAGER: Permission[] = [
  "quote.view",
  "quote.create",
  "quote.edit",
  "quote.submit",
  "quote.approve",
  "quote.send",
  "quote.cancel.any",
  "quote.cancel.own",
  "quote.assign",
  "import.run",
  "attention.resolve",
  "jobs.retry",
  "export.all",
];

const MATRIX: Record<Role, Permission[]> = {
  OWNER: [...MANAGER, "settings.manage", "team.manage"],
  MANAGER,
  // A rep may send only APPROVED quotes; the status machine enforces that.
  REP: ["quote.view", "quote.create", "quote.edit", "quote.submit", "quote.send", "quote.cancel.own", "import.run"],
  VIEWER: ["quote.view"],
};

// Jobs and webhooks may do everything; customer actions are checked separately (M3.4).
const can = (actor: Actor, permission: Permission): boolean => {
  if (actor.type === "SYSTEM" || actor.type === "WEBHOOK") return true;
  if (actor.type === "CUSTOMER") return false;
  return MATRIX[actor.role].includes(permission);
};

const requirePermission = (actor: Actor, permission: Permission) => {
  if (can(actor, permission)) return;
  console.warn("permission denied", { shop: actor.shop, type: actor.type, permission });
  throw new ForbiddenError();
};

// Any quote with cancel.any; only quotes assigned to you with cancel.own.
const requireCancel = (actor: Actor, quote: { assignedToUserId: bigint | null }) => {
  if (can(actor, "quote.cancel.any")) return;
  const isOwn =
    actor.type === "STAFF" && actor.userId !== null && quote.assignedToUserId === actor.userId;
  if (isOwn && can(actor, "quote.cancel.own")) return;
  throw new ForbiddenError();
};

export { MATRIX, ROLES, can, requireCancel, requirePermission };
export type { Permission };
