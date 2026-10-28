import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Who did something. Staff details become real in M2.2.
type Role = "OWNER" | "MANAGER" | "REP" | "VIEWER";
type StaffActor = {
  type: "STAFF";
  shop: string;
  userId: bigint | null;
  name: string;
  role: Role;
  locale: string;
  admin: AdminApiContext;
};
type CustomerActor = { type: "CUSTOMER"; shop: string; customerId: string };
type SystemActor = { type: "SYSTEM"; shop: string; reason: string }; // background jobs
type WebhookActor = { type: "WEBHOOK"; shop: string; reason: string }; // changes caused by Shopify webhooks
type Actor = StaffActor | CustomerActor | SystemActor | WebhookActor;

const actorId = (actor: Actor): string | null => {
  if (actor.type === "STAFF") return actor.userId?.toString() ?? null;
  if (actor.type === "CUSTOMER") return actor.customerId;
  return actor.reason;
};

export { actorId };
export type { Actor, CustomerActor, Role, StaffActor, SystemActor, WebhookActor };
