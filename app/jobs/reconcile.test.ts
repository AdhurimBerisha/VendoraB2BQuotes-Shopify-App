import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../db.server";
import type { AttentionItem } from "../models/attention";
import { redactShop } from "../models/privacy.server";
import { STALE_MS, runSync } from "../models/sync.server";
import { quoteTag } from "../shopify/draft-orders.server";
import { testQuote, testShop } from "../test/factories";
import { fakeShopify } from "../test/fake-shopify";
import { enqueue } from "./queue.server";
import { runReconcileAll, runReconcileShop } from "./reconcile.server";

vi.mock("./queue.server", () => ({ enqueue: vi.fn(async () => "job-id"), getBoss: vi.fn(async () => ({})) }));
const enqueueMock = vi.mocked(enqueue);

let SHOP: string;
let GONE: string;

beforeAll(async () => {
  SHOP = (await testShop()).id;
  GONE = (await testShop({ uninstalledAt: new Date() })).id;
});

beforeEach(() => enqueueMock.mockClear());

afterAll(async () => {
  await redactShop(SHOP);
  await redactShop(GONE);
  await db.$disconnect();
});

const load = (id: string) => db.quote.findUniqueOrThrow({ where: { id } });
const codes = (attention: unknown) => ((attention as AttentionItem[] | null) ?? []).map((item) => item.code);
const deps = (shopify: ReturnType<typeof fakeShopify>) => ({ getAdmin: async () => shopify.admin });

// A SENT quote synced to a draft order in the fake (testQuote: variant 1 × 2).
const sentQuote = async (shopify: ReturnType<typeof fakeShopify>) => {
  const quote = await testQuote(SHOP, { overrides: { status: "SENT", syncStatus: "SYNCED" } });
  const draft = shopify.seedDraft({
    tags: [quoteTag(quote.id)],
    companyId: quote.companyId,
    locationId: quote.companyLocationId,
    lines: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 2 }],
  });
  await db.quote.update({ where: { id: quote.id }, data: { draftOrderId: draft.id, syncedVersionId: quote.currentVersionId } });
  return { quote, draft };
};
const inStock = { "gid://shopify/ProductVariant/1": { price: "10.00", inventoryQuantity: 100 } };

test("draft order deleted without a webhook: DRAFT_DELETED, draftOrderId cleared", async () => {
  const shopify = fakeShopify({ variants: inStock });
  const { quote, draft } = await sentQuote(shopify);
  shopify.deleteDraftInShopify(draft.id);

  await runReconcileShop(SHOP, deps(shopify));

  const saved = await load(quote.id);
  expect(saved.draftOrderId).toBeNull();
  expect(saved.syncStatus).toBe("NEEDS_ATTENTION");
  expect(codes(saved.attention)).toEqual(["DRAFT_DELETED"]);
});

test("order completed without a webhook: quote ORDERED via reconcile", async () => {
  const shopify = fakeShopify({ variants: inStock });
  const { quote, draft } = await sentQuote(shopify);
  shopify.completeDraft(draft.id, "gid://shopify/Order/555");

  await runReconcileShop(SHOP, deps(shopify));

  const saved = await load(quote.id);
  expect(saved.status).toBe("ORDERED");
  expect(saved.orderId).toBe("gid://shopify/Order/555");
  const [event] = await db.auditEvent.findMany({ where: { quoteId: quote.id, action: "quote.ordered" } });
  expect(event.data).toMatchObject({ via: "reconcile" });
});

test("draft edited in Shopify without a webhook: CHANGED_IN_SHOPIFY once, not again the next night", async () => {
  const shopify = fakeShopify({ variants: inStock });
  const { quote, draft } = await sentQuote(shopify);
  shopify.editDraftInShopify(draft.id, [{ variantId: "gid://shopify/ProductVariant/1", quantity: 9 }]);

  await runReconcileShop(SHOP, deps(shopify));
  await runReconcileShop(SHOP, deps(shopify));

  const saved = await load(quote.id);
  expect(saved.syncStatus).toBe("NEEDS_ATTENTION");
  const [item] = (saved.attention as AttentionItem[]) ?? [];
  expect(item).toMatchObject({ code: "CHANGED_IN_SHOPIFY", data: { theirs: "gid://shopify/ProductVariant/1:9" } });
  expect(await db.auditEvent.count({ where: { quoteId: quote.id, action: "attention.raised" } })).toBe(1);
});

test("a quote in sync stays untouched", async () => {
  const shopify = fakeShopify({ variants: inStock });
  const { quote } = await sentQuote(shopify);

  await runReconcileShop(SHOP, deps(shopify));

  const saved = await load(quote.id);
  expect(saved.syncStatus).toBe("SYNCED");
  expect(saved.attention).toBeNull();
});

test("stock fell below a sent quote's quantity: OUT_OF_STOCK once; cleared when stock is back", async () => {
  const low = fakeShopify({ variants: { "gid://shopify/ProductVariant/1": { price: "10.00", inventoryQuantity: 1 } } });
  const { quote, draft } = await sentQuote(low);

  await runReconcileShop(SHOP, deps(low));
  await runReconcileShop(SHOP, deps(low));
  let saved = await load(quote.id);
  expect(codes(saved.attention)).toEqual(["OUT_OF_STOCK"]);
  expect(await db.auditEvent.count({ where: { quoteId: quote.id, action: "attention.raised" } })).toBe(1);

  const restocked = fakeShopify({ variants: inStock });
  restocked.seedDraft({ ...draft });
  await db.quote.update({ where: { id: quote.id }, data: { draftOrderId: restocked.drafts[0].id } });
  await runReconcileShop(SHOP, deps(restocked));
  saved = await load(quote.id);
  expect(saved.attention).toBeNull();
});

test("a sync stuck for 2 h is queued again; the job then makes exactly one draft order", async () => {
  const shopify = fakeShopify({ variants: inStock });
  const quote = await testQuote(SHOP, { overrides: { status: "APPROVED", syncStatus: "SYNCING" } });
  await db.quote.update({ where: { id: quote.id }, data: { syncClaimedAt: new Date(Date.now() - 2 * 3_600_000) } });

  await runReconcileShop(SHOP, deps(shopify));

  const queued = enqueueMock.mock.calls.filter(([name, data]) => name === "sync-draft-order" && (data as { quoteId: string }).quoteId === quote.id);
  expect(queued).toHaveLength(1);
  expect(Date.now() - 2 * 3_600_000).toBeLessThan(Date.now() - STALE_MS); // older than the stale window, so claimable
  await runSync(shopify.admin, queued[0][1] as Parameters<typeof runSync>[1]);
  expect(shopify.creates()).toBe(1);
  expect((await load(quote.id)).syncStatus).toBe("SYNCED");
});

test("uninstalled shop: not reconciled, Shopify never asked", async () => {
  let asked = false;
  await runReconcileShop(GONE, {
    getAdmin: async () => {
      asked = true;
      return fakeShopify().admin;
    },
  });
  expect(asked).toBe(false);
});

test("reconcile-all queues one job per installed shop, never for uninstalled ones", async () => {
  await runReconcileAll();

  const shops = enqueueMock.mock.calls.filter(([name]) => name === "reconcile").map(([, data]) => (data as { shop: string }).shop);
  expect(shops).toContain(SHOP);
  expect(shops).not.toContain(GONE);
  expect(new Set(shops).size).toBe(shops.length);
});
