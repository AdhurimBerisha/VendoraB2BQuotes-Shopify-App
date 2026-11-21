import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { type Actor, actorId } from "./actor";
import { queueFlowTrigger } from "./flow.server";

type Tx = Prisma.TransactionClient | typeof db;

// Append-only history. Call inside the same transaction as the change it records.
// Quote events that are Shopify Flow triggers (M9.4) also queue the trigger here, in that transaction.
// Action names are listed in roadmap/dev/M2.1 (quote.created, quote.lines_saved, sync.succeeded, …).
const audit = async (
  tx: Tx,
  actor: Actor,
  quoteId: string | null,
  action: string,
  data?: Prisma.InputJsonValue,
) => {
  await tx.auditEvent.create({
    data: { shop: actor.shop, quoteId, actorType: actor.type, actorId: actorId(actor), action, data },
  });
  await queueFlowTrigger(tx, actor.shop, quoteId, action);
};

const quoteHistory = (shop: string, quoteId: string) =>
  db.auditEvent.findMany({ where: { shop, quoteId }, orderBy: { createdAt: "asc" } });

export { audit, quoteHistory };
