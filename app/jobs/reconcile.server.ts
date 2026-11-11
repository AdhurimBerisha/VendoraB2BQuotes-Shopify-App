import { logger } from "../lib/logger.server";
import { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { ShopifyThrottled } from "../shopify/client.server";
import { getDraftForReconcile } from "../shopify/draft-orders.server";
import { getVariantPrices } from "../shopify/products.server";
import type { SystemActor } from "../models/actor";
import { attentionItems, withoutItems } from "../models/attention";
import { raise } from "../models/attention.server";
import { audit } from "../models/audit.server";
import { notify } from "../models/notify.server";
import { transition } from "../models/quote.server";
import { isInstalled } from "../models/shop.server";
import type { SyncJob } from "../models/sync.server";
import { lineProblems } from "../models/version.server";
import { linesKey } from "../models/webhooks.server";
import { enqueue, getBoss } from "./queue.server";

// M4.3: the nightly safety net for webhooks Shopify never delivered (or we lost). It compares each
// open quote with its draft order and does what the webhook would have done, or flags it.

type Deps = { getAdmin: (shop: string) => Promise<AdminApiContext> };
const defaultDeps: Deps = { getAdmin: async (shop) => (await unauthenticated.admin(shop)).admin };

const SPREAD_SECONDS = 1800;
const STUCK_MS = 60 * 60_000;

// 03:00 UTC: one reconcile job per installed shop, spread over 30 minutes (Shopify rate limits).
const runReconcileAll = async () => {
  const shops = await db.shop.findMany({ where: { uninstalledAt: null }, select: { id: true }, orderBy: { id: "asc" } });
  for (const [index, shop] of shops.entries()) {
    await enqueue("reconcile", { shop: shop.id }, {
      singletonKey: `reconcile:${shop.id}`,
      startAfter: Math.floor((index * SPREAD_SECONDS) / shops.length),
    }).catch((error: unknown) => logger.warn({ shop: shop.id, error: String(error) }, "reconcile not queued (already queued?)"));
  }
  logger.info({ shops: shops.length }, "reconcile fanned out");
};

type OpenQuote = Prisma.QuoteGetPayload<{ include: { versions: { include: { lines: true } } } }>;
type Outcome = "ok" | "ordered" | "deleted" | "changed" | "skipped";

const checkQuote = async (admin: AdminApiContext, shop: string, quote: OpenQuote): Promise<Outcome> => {
  const actor: SystemActor = { type: "SYSTEM", shop, reason: "reconcile" };
  const draftOrderId = quote.draftOrderId;
  if (!draftOrderId) return "skipped";
  const draft = await getDraftForReconcile(admin, draftOrderId);

  return db.$transaction(async (tx) => {
    // Re-read inside the transaction: a webhook or sync may have changed it meanwhile.
    const current = await tx.quote.findFirst({ where: { id: quote.id, shop } });
    if (!current || current.draftOrderId !== draftOrderId || !["APPROVED", "SENT"].includes(current.status)) return "skipped";
    if (current.syncStatus === "QUEUED" || current.syncStatus === "SYNCING") return "skipped"; // our sync is writing it

    if (!draft) {
      // Missed draft_orders/delete (same as onDraftDelete).
      await tx.quote.update({ where: { id: quote.id }, data: { draftOrderId: null, syncedVersionId: null, syncStatus: "NEEDS_ATTENTION" } });
      await raise(tx, shop, quote.id, { code: "DRAFT_DELETED" });
      await audit(tx, actor, quote.id, "attention.raised", { code: "DRAFT_DELETED", via: "reconcile" });
      return "deleted";
    }
    if (draft.status === "COMPLETED" && draft.order) {
      // Missed draft_orders/update on completion (same as onDraftUpdate).
      await transition(tx, shop, quote.id, "order", "ORDERED", { orderId: draft.order.id });
      await audit(tx, actor, quote.id, "quote.ordered", { orderId: draft.order.id, via: "reconcile" });
      await notify(tx, shop, "quoteOrdered", { kind: "user", userId: current.assignedToUserId }, { quoteId: quote.id });
      return "ordered";
    }
    const synced = quote.versions.find((version) => version.id === current.syncedVersionId);
    if (!synced) return "ok";
    const ours = linesKey(synced.lines);
    const theirs = linesKey(
      draft.lineItems.nodes.flatMap((line) => (line.variant ? [{ variantId: line.variant.id, quantity: line.quantity }] : [])),
    );
    if (ours === theirs) return "ok";
    const known = attentionItems(current.attention).find((item) => item.code === "CHANGED_IN_SHOPIFY");
    if (known?.data?.theirs === theirs) return "ok"; // already flagged, nothing new
    await tx.quote.update({ where: { id: quote.id }, data: { syncStatus: "NEEDS_ATTENTION" } });
    await raise(tx, shop, quote.id, { code: "CHANGED_IN_SHOPIFY", data: { ours, theirs } });
    await audit(tx, actor, quote.id, "attention.raised", { code: "CHANGED_IN_SHOPIFY", via: "reconcile" });
    return "changed";
  });
};

// Scenario 3 after send: stock fell below a SENT quote's quantities → Needs attention (a warning;
// the buyer can still check out). Cleared again once stock is back.
const checkStock = async (admin: AdminApiContext, shop: string, quote: OpenQuote) => {
  const version = quote.versions.find((item) => item.id === quote.currentVersionId);
  if (quote.status !== "SENT" || !version?.lines.length) return false;
  const prices = await getVariantPrices(admin, [...new Set(version.lines.map((line) => line.variantId))], quote.companyLocationId);
  const short = version.lines.filter((line) => {
    const price = prices.get(line.variantId);
    return price !== undefined && lineProblems(price, line.quantity, quote.currencyCode).includes("OUT_OF_STOCK");
  });
  const flagged = attentionItems(quote.attention).some((item) => item.code === "OUT_OF_STOCK");
  if (short.length === 0) {
    if (flagged) {
      await db.quote.update({ where: { id: quote.id }, data: { attention: withoutItems(quote.attention, ["OUT_OF_STOCK"]) ?? Prisma.DbNull } });
    }
    return false;
  }
  if (flagged) return false; // already told; don't email every night
  await db.$transaction(async (tx) => {
    await raise(tx, shop, quote.id, { code: "OUT_OF_STOCK", message: short.map((line) => line.titleSnapshot).join(", ") });
    await audit(tx, { type: "SYSTEM", shop, reason: "reconcile" }, quote.id, "attention.raised", { code: "OUT_OF_STOCK", via: "reconcile" });
  });
  return true;
};

const runReconcileShop = async (shop: string, deps: Deps = defaultDeps) => {
  if (!(await isInstalled(shop))) {
    logger.info({ shop }, "reconcile skipped: shop not installed");
    return;
  }
  const admin = await deps.getAdmin(shop);
  await getBoss(); // notify and enqueue send jobs inside transactions (see enqueue)
  const quotes = await db.quote.findMany({
    where: { shop, draftOrderId: { not: null }, status: { in: ["APPROVED", "SENT"] } },
    include: { versions: { include: { lines: true } } },
  });

  const counts: Record<Outcome | "failed" | "lowStock", number> = { ok: 0, ordered: 0, deleted: 0, changed: 0, skipped: 0, failed: 0, lowStock: 0 };
  for (const quote of quotes) {
    try {
      const outcome = await checkQuote(admin, shop, quote);
      counts[outcome]++;
      if (outcome === "ok" && (await checkStock(admin, shop, quote))) counts.lowStock++;
    } catch (error) {
      if (error instanceof ShopifyThrottled) throw error; // pg-boss retries the whole shop later (all steps are safe to repeat)
      counts.failed++;
      logger.warn({ shop, quoteId: quote.id, error: error instanceof Error ? error.message : String(error) }, "reconcile: quote check failed");
    }
  }

  // Syncs claimed over an hour ago whose job is gone: queue them again (the claim and the tag
  // lookup prevent a second draft order).
  const stuck = await db.quote.findMany({
    where: { shop, syncStatus: "SYNCING", syncClaimedAt: { lt: new Date(Date.now() - STUCK_MS) } },
    select: { id: true },
  });
  for (const { id } of stuck) {
    const job: SyncJob = { shop, quoteId: id, op: "upsert" };
    await enqueue("sync-draft-order", job, { singletonKey: id }).catch((error: unknown) =>
      logger.warn({ shop, quoteId: id, error: String(error) }, "reconcile: stuck sync not re-queued (a job exists)"),
    );
  }
  logger.info({ shop, checked: quotes.length, ...counts, stuck: stuck.length }, "reconcile done");
};

export { runReconcileAll, runReconcileShop };
