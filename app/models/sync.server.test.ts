import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../db.server";
import { fakeShopify } from "../test/fake-shopify";
import { testQuote, testShop } from "../test/factories";
import { redactShop } from "./privacy.server";
import { STALE_MS, SyncInFlight, runSync } from "./sync.server";

let SHOP: string;

beforeAll(async () => {
  SHOP = (await testShop()).id;
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

// runSync runs inside the sync-draft-order job, so quotes start QUEUED.
const queuedQuote = () => testQuote(SHOP, { overrides: { syncStatus: "QUEUED" } });

test("quote synced twice at once creates one draft order", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();

  const results = await Promise.allSettled([
    runSync(shopify.admin, SHOP, quote.id),
    runSync(shopify.admin, SHOP, quote.id),
  ]);

  // The loser either sees SYNCING (throws so pg-boss retries) or already SYNCED.
  for (const result of results) {
    if (result.status === "rejected") expect(result.reason).toBeInstanceOf(SyncInFlight);
  }
  expect(shopify.creates()).toBe(1);
  const saved = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
  expect(saved.syncStatus).toBe("SYNCED");
  expect(saved.draftOrderId).toBe(shopify.drafts[0].id);
  expect(saved.syncedVersionId).toBe(quote.currentVersionId);
});

test("crash after Shopify created the order: retry adopts it, no duplicate", async () => {
  const shopify = fakeShopify({ crashAfterCreate: true });
  const quote = await queuedQuote();

  await expect(runSync(shopify.admin, SHOP, quote.id)).rejects.toThrow("socket hang up");
  // Ambiguous failure: stays SYNCING and an early retry backs off.
  await expect(runSync(shopify.admin, SHOP, quote.id)).rejects.toBeInstanceOf(SyncInFlight);

  await db.quote.update({
    where: { id: quote.id },
    data: { syncClaimedAt: new Date(Date.now() - STALE_MS - 1000) },
  });
  const saved = await runSync(shopify.admin, SHOP, quote.id);

  expect(shopify.creates()).toBe(1);
  expect(saved.syncStatus).toBe("SYNCED");
  expect(saved.draftOrderId).toBe(shopify.drafts[0].id);
  const actions = (await db.auditEvent.findMany({ where: { quoteId: quote.id } })).map(
    (event) => event.action,
  );
  expect(actions).toEqual(["sync.adopted"]);
});

test("another shop cannot sync the quote", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();

  await expect(runSync(shopify.admin, "other-shop.myshopify.com", quote.id)).rejects.toThrow();

  expect(shopify.creates()).toBe(0);
  const saved = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
  expect(saved.syncStatus).toBe("QUEUED");
});

test("a quote that isn't QUEUED is never synced without going through the queue", async () => {
  const shopify = fakeShopify();
  const quote = await testQuote(SHOP); // syncStatus NONE

  const result = await runSync(shopify.admin, SHOP, quote.id);

  expect(shopify.creates()).toBe(0);
  expect(result.syncStatus).toBe("NONE");
});
