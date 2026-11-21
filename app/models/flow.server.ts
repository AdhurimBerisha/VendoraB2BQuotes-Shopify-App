import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { enqueue } from "../jobs/queue.server";

type Tx = Prisma.TransactionClient | typeof db;

// M9.4: Shopify Flow triggers (extensions/vendora-quote-*). Quote history action → trigger handle.
// No separate "accepted": the buyer accepts by paying in Shopify's checkout, which is "ordered".
const FLOW_TRIGGERS: Record<string, string> = {
  "quote.approved": "vendora-quote-approved",
  "quote.sent": "vendora-quote-sent",
  "quote.ordered": "vendora-quote-ordered",
  "quote.declined": "vendora-quote-declined",
  "quote.expired": "vendora-quote-expired",
};

type FlowTriggerJob = { shop: string; quoteId: string; handle: string };

// Called by audit() for every history entry: queues a flow-trigger job in the same transaction, so a
// change that rolls back never starts a workflow. The job sends it (app/jobs/flow-trigger.server.ts).
// ponytail: sent whether or not a workflow uses the trigger; add Flow's lifecycle callback if the
// extra calls ever matter.
const queueFlowTrigger = async (tx: Tx, shop: string, quoteId: string | null, action: string) => {
  const handle = FLOW_TRIGGERS[action];
  if (!handle || !quoteId) return;
  const job: FlowTriggerJob = { shop, quoteId, handle };
  await enqueue("flow-trigger", job, { tx });
};

export { FLOW_TRIGGERS, queueFlowTrigger };
export type { FlowTriggerJob };
