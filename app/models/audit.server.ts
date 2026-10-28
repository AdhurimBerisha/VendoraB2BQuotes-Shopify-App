import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { type Actor, actorId } from "./actor";

type Tx = Prisma.TransactionClient | typeof db;

// Append-only history. Call inside the same transaction as the change it records.
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
};

const quoteHistory = (shop: string, quoteId: string) =>
  db.auditEvent.findMany({ where: { shop, quoteId }, orderBy: { createdAt: "asc" } });

export { audit, quoteHistory };
