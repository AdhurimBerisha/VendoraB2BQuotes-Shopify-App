import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { enqueue, getBoss } from "../jobs/queue.server";
import { ConflictError } from "../lib/errors";
import { ShopifyUserErrors, call, throwOnUserErrors } from "../shopify/client.server";
import type { Actor, SystemActor } from "./actor";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";

// ponytail: draftOrderCreate has no @idempotent support, so a crashed attempt is only
// reclaimed after STALE_MS and found again by tag. Relies on Shopify's draft-order search
// index catching up within this window; switch to @idempotent if Shopify adds it.
const STALE_MS = 2 * 60_000;

const quoteTag = (quoteId: string) => `vendora-quote-${quoteId}`;

// Thrown when another attempt holds the quote; the job throws so pg-boss retries later.
class SyncInFlight extends Error {}

type SyncableQuote = {
  id: string;
  companyId: string;
  companyLocationId: string;
  companyContactId: string;
  currentVersion: { lines: { variantId: string; quantity: number }[] } | null;
};

// syncStatus NONE | FAILED → QUEUED, and the job, in one transaction: a QUEUED quote always
// has a job. M2.6 adds re-syncing a SYNCED quote (draftOrderUpdate).
const requestSync = async (actor: Actor, quoteId: string) => {
  requirePermission(actor, "quote.send");
  await getBoss(); // start pg-boss outside the transaction (see enqueue)
  await db.$transaction(async (tx) => {
    const { count } = await tx.quote.updateMany({
      where: { id: quoteId, shop: actor.shop, syncStatus: { in: ["NONE", "FAILED"] } },
      data: { syncStatus: "QUEUED", syncError: null },
    });
    if (count !== 1) throw new ConflictError("sync.errors.alreadyRunning");
    await enqueue("sync-draft-order", { shop: actor.shop, quoteId }, { singletonKey: quoteId, tx });
    await audit(tx, actor, quoteId, "sync.requested");
  });
  console.log("sync queued", { shop: actor.shop, quoteId });
};

// Runs inside the sync-draft-order job. syncStatus: QUEUED → SYNCING → SYNCED | FAILED.
const runSync = async (admin: AdminApiContext, shop: string, quoteId: string) => {
  // Atomic claim: only one caller moves the quote into SYNCING.
  const now = new Date();
  const claimed = await db.quote.updateMany({
    where: {
      id: quoteId,
      shop,
      OR: [
        { syncStatus: "QUEUED" },
        { syncStatus: "SYNCING", syncClaimedAt: { lt: new Date(now.getTime() - STALE_MS) } },
      ],
    },
    data: { syncStatus: "SYNCING", syncClaimedAt: now },
  });
  const quote = await db.quote.findFirstOrThrow({
    where: { id: quoteId, shop },
    include: { currentVersion: { include: { lines: { orderBy: { position: "asc" } } } } },
  });
  if (claimed.count === 0) {
    if (quote.syncStatus === "SYNCING") {
      throw new SyncInFlight(`Quote ${quoteId} is being synced by another attempt`);
    }
    return quote; // SYNCED / FAILED / NONE: nothing to do
  }

  const system: SystemActor = { type: "SYSTEM", shop, reason: "sync-draft-order" };
  try {
    const found = await findDraftOrderId(admin, quote.id);
    const draftOrderId = found ?? (await createDraftOrder(admin, quote));
    return await db.$transaction(async (tx) => {
      await audit(tx, system, quote.id, found ? "sync.adopted" : "sync.succeeded", { draftOrderId });
      return tx.quote.update({
        where: { id: quote.id },
        data: { syncStatus: "SYNCED", draftOrderId, syncedVersionId: quote.currentVersionId },
      });
    });
  } catch (error) {
    if (error instanceof ShopifyUserErrors) {
      // Shopify rejected the input, so nothing was created: safe to retry right away.
      return db.$transaction(async (tx) => {
        await audit(tx, system, quote.id, "sync.failed", { message: error.message });
        return tx.quote.update({
          where: { id: quote.id },
          data: { syncStatus: "FAILED", syncError: error.message },
        });
      });
    }
    // Ambiguous (network, timeout, 5xx): Shopify may have created it. Stay SYNCING
    // so only a stale reclaim retries, and that retry finds the order by tag.
    throw error;
  }
};

const findDraftOrderId = async (admin: AdminApiContext, quoteId: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraDraftOrderByTag($query: String!) {
        draftOrders(first: 5, query: $query) {
          nodes { id status purchasingEntity { ... on PurchasingCompany { company { id } location { id } } } }
        }
      }`,
      { variables: { query: `tag:'${quoteTag(quoteId)}'` } },
    ),
  );
  const { data } = await response.json();
  return data?.draftOrders.nodes[0]?.id ?? null; // M2.6: check company/location match (B-1)
};

const createDraftOrder = async (admin: AdminApiContext, quote: SyncableQuote) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      mutation VendoraDraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) { draftOrder { id name updatedAt } userErrors { field message } }
      }`,
      {
        variables: {
          input: {
            purchasingEntity: {
              purchasingCompany: {
                companyId: quote.companyId,
                companyLocationId: quote.companyLocationId,
                companyContactId: quote.companyContactId,
              },
            },
            lineItems: (quote.currentVersion?.lines ?? []).map((line) => ({
              variantId: line.variantId,
              quantity: line.quantity,
            })),
            tags: [quoteTag(quote.id)],
          },
        },
      },
    ),
  );
  const { data } = await response.json();
  throwOnUserErrors(data?.draftOrderCreate?.userErrors);
  const draftOrder = data?.draftOrderCreate?.draftOrder;
  if (!draftOrder) throw new Error("draftOrderCreate returned no draft order");
  return draftOrder.id;
};

export { STALE_MS, SyncInFlight, quoteTag, requestSync, runSync };
