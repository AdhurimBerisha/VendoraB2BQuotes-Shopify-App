import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../db.server";
import { submitQuote } from "../models/approval.server";
import { redactShop } from "../models/privacy.server";
import { requestQuoteFromStorefront } from "../models/quote-request.server";
import { STALE_MS, runSync } from "../models/sync.server";
import { processWebhook } from "../models/webhooks.server";
import type { AttentionItem } from "../models/attention";
import { ShopifyThrottled } from "../shopify/client.server";
import { staff, testQuote, testShop } from "./factories";
import { type Fault, fakeShopify } from "./fake-shopify";

// Failure scenarios from roadmap/08-phase-4-reliability.md §1 that no milestone test covers yet.
// The rest of the matrix points at the milestone tests (see the "Test (file)" column).

vi.mock("../jobs/queue.server", () => ({ enqueue: vi.fn(async () => "job-id"), getBoss: vi.fn(async () => ({})) }));

// Scenario 14: makes notify (the last write of a request's transaction) fail like a lost database.
const dbDown = vi.hoisted(() => ({ on: false }));
vi.mock("../models/notify.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("../models/notify.server")>();
  return {
    ...real,
    notify: async (...args: Parameters<typeof real.notify>) => {
      if (dbDown.on) throw new Error("Can't reach database server at localhost:5432");
      return real.notify(...args);
    },
  };
});

let SHOP: string;

beforeAll(async () => {
  // USD quotes up to 10 000 pass without approval (no threshold means "always ask a manager").
  const rules = { maxDiscountPct: 15, maxTotalByCurrency: { USD: 10000 }, alwaysRequire: false, requireDifferentApprover: true };
  SHOP = (await testShop({ approvalRules: rules })).id;
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

const load = (id: string) => db.quote.findUniqueOrThrow({ where: { id } });
const codes = (attention: unknown) => ((attention as AttentionItem[] | null) ?? []).map((item) => item.code);
const upsert = (quoteId: string) => ({ shop: SHOP, quoteId, op: "upsert" as const });
const backdateClaim = (quoteId: string) =>
  db.quote.update({ where: { id: quoteId }, data: { syncClaimedAt: new Date(Date.now() - STALE_MS - 1000) } });

// Scenarios 12, 12b (M4.2): throttled means nothing happened, so the claim is released at once
// and the next attempt runs without waiting for the stale window.
test.each<Fault>(["throttled", "http429"])("create %s: claim released, the retry makes exactly one draft order", async (fault) => {
  const shopify = fakeShopify();
  shopify.failNext("VendoraDraftOrderCreate", fault);
  const quote = await testQuote(SHOP, { overrides: { syncStatus: "QUEUED" } });

  await expect(runSync(shopify.admin, upsert(quote.id))).rejects.toBeInstanceOf(ShopifyThrottled);
  expect(shopify.drafts).toHaveLength(0);
  const released = await load(quote.id);
  expect(released.syncStatus).toBe("QUEUED");
  expect(released.syncClaimedAt).toBeNull();

  await runSync(shopify.admin, upsert(quote.id)); // no backdating needed

  expect(shopify.drafts).toHaveLength(1);
  expect((await load(quote.id)).syncStatus).toBe("SYNCED");
});

// Scenario 5b: 5xx or a lost connection may have happened in Shopify, so the quote stays claimed
// until the stale window; the retry then finds or creates exactly one draft order.
test.each<Fault>(["http500", "network"])("create fails with %s: kept claimed, the stale retry makes one draft order", async (fault) => {
  const shopify = fakeShopify();
  shopify.failNext("VendoraDraftOrderCreate", fault);
  const quote = await testQuote(SHOP, { overrides: { syncStatus: "QUEUED" } });

  await expect(runSync(shopify.admin, upsert(quote.id))).rejects.toThrow();
  expect((await load(quote.id)).syncStatus).toBe("SYNCING");

  await backdateClaim(quote.id);
  await runSync(shopify.admin, upsert(quote.id));

  expect(shopify.drafts).toHaveLength(1);
  expect(shopify.callsOf("VendoraDraftOrderCreate")).toBe(2);
  expect((await load(quote.id)).draftOrderId).toBe(shopify.drafts[0].id);
});

test("access denied (missing scope or plan): FAILED with SYNC_FAILED, not retried", async () => {
  const shopify = fakeShopify();
  shopify.failNext("VendoraDraftOrderCreate", "accessDenied");
  const quote = await testQuote(SHOP, { overrides: { syncStatus: "QUEUED" } });

  await runSync(shopify.admin, upsert(quote.id)); // returns: pg-boss doesn't retry

  const saved = await load(quote.id);
  expect(saved.syncStatus).toBe("FAILED");
  expect(saved.syncError).toMatch(/^Missing permission/);
  expect(codes(saved.attention)).toEqual(["SYNC_FAILED"]);
  expect(shopify.drafts).toHaveLength(0);
});

test("scenario 1: the order webhook arrives twice (later update too): one ORDERED transition", async () => {
  const quote = await testQuote(SHOP, { overrides: { status: "SENT", syncStatus: "SYNCED" } });
  await db.quote.update({
    where: { id: quote.id },
    data: { draftOrderId: "gid://shopify/DraftOrder/9001", syncedVersionId: quote.currentVersionId },
  });
  const completed = (updatedAt: string) => ({
    id: 9001,
    status: "completed",
    order_id: 77,
    updated_at: updatedAt,
    line_items: [{ variant_id: 1, quantity: 2 }],
  });

  await processWebhook("DRAFT_ORDERS_UPDATE", SHOP, completed("2026-11-04T10:00:00Z"));
  await processWebhook("DRAFT_ORDERS_UPDATE", SHOP, completed("2026-11-04T10:00:05Z"));

  const saved = await load(quote.id);
  expect(saved.status).toBe("ORDERED");
  expect(saved.orderId).toBe("gid://shopify/Order/77");
  expect(saved.attention).toBeNull();
  expect(await db.auditEvent.count({ where: { quoteId: quote.id, action: "quote.ordered" } })).toBe(1);
});

test("scenario 3: stock fell below the quantity before submit: flagged as a warning, not blocked", async () => {
  // testQuote: variant 1 × 2 at 10.00. Only 1 left in Shopify now.
  const shopify = fakeShopify({ variants: { "gid://shopify/ProductVariant/1": { price: "10.00", inventoryQuantity: 1 } } });
  const quote = await testQuote(SHOP);

  await submitQuote(staff(SHOP, shopify.admin), quote.id);

  const saved = await db.quote.findUniqueOrThrow({ where: { id: quote.id }, include: { currentVersion: { include: { lines: true } } } });
  expect(saved.status).toBe("APPROVED");
  expect(saved.currentVersion?.lines[0].problems).toEqual(["OUT_OF_STOCK"]);
});

test("scenario 14: the database fails mid-request: nothing half-written, the number isn't used up", async () => {
  const shopify = fakeShopify({ variants: { "gid://shopify/ProductVariant/1": { price: "10.00" } } });
  const before = await db.shop.findUniqueOrThrow({ where: { id: SHOP } });
  const quotes = await db.quote.count({ where: { shop: SHOP } });
  const body = { locationId: 1, lines: [{ variantId: 1, quantity: 2 }] };

  dbDown.on = true;
  try {
    await expect(requestQuoteFromStorefront(shopify.admin, SHOP, "gid://shopify/Customer/1", body)).rejects.toThrow(
      "Can't reach database server",
    );
  } finally {
    dbDown.on = false;
  }

  expect(await db.quote.count({ where: { shop: SHOP } })).toBe(quotes);
  expect((await db.shop.findUniqueOrThrow({ where: { id: SHOP } })).nextQuoteNumber).toBe(before.nextQuoteNumber);
});
