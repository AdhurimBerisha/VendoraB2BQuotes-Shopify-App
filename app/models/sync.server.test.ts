import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../db.server";
import { enqueue } from "../jobs/queue.server";
import { D } from "../lib/money";
import { quoteTag } from "../shopify/draft-orders.server";
import { fakeShopify } from "../test/fake-shopify";
import { staff, testQuote, testShop } from "../test/factories";
import type { AttentionItem } from "./attention";
import { redactShop } from "./privacy.server";
import { cancelQuote } from "./quote.server";
import { STALE_MS, SyncInFlight, runSendInvoice, runSync } from "./sync.server";

vi.mock("../jobs/queue.server", () => ({ enqueue: vi.fn(async () => "job-id"), getBoss: vi.fn(async () => ({})) }));
const enqueueMock = vi.mocked(enqueue);

let SHOP: string;

beforeAll(async () => {
  SHOP = (await testShop()).id;
});

beforeEach(() => enqueueMock.mockClear());

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

// runSync runs inside the sync-draft-order job, so quotes start QUEUED.
const queuedQuote = () => testQuote(SHOP, { overrides: { syncStatus: "QUEUED" } });
const upsert = (quoteId: string, send?: { message: string }) => ({ shop: SHOP, quoteId, op: "upsert" as const, send });
const load = (id: string) => db.quote.findUniqueOrThrow({ where: { id } });
const codes = (attention: unknown) => ((attention as AttentionItem[] | null) ?? []).map((item) => item.code);
const actions = async (quoteId: string) =>
  (await db.auditEvent.findMany({ where: { quoteId }, orderBy: { createdAt: "asc" } })).map((event) => event.action);

test("quote synced twice at once creates one draft order", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();

  const results = await Promise.allSettled([
    runSync(shopify.admin, upsert(quote.id)),
    runSync(shopify.admin, upsert(quote.id)),
  ]);

  // The loser either sees SYNCING (throws so pg-boss retries) or already SYNCED.
  for (const result of results) {
    if (result.status === "rejected") expect(result.reason).toBeInstanceOf(SyncInFlight);
  }
  expect(shopify.creates()).toBe(1);
  const saved = await load(quote.id);
  expect(saved.syncStatus).toBe("SYNCED");
  expect(saved.draftOrderId).toBe(shopify.drafts[0].id);
  expect(saved.syncedVersionId).toBe(quote.currentVersionId);
});

test("create: input has addresses, tag, purchasing entity and note", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();

  await runSync(shopify.admin, upsert(quote.id));

  const input = shopify.drafts[0].input;
  expect(input.purchasingEntity).toEqual({
    purchasingCompany: {
      companyId: quote.companyId,
      companyLocationId: quote.companyLocationId,
      companyContactId: quote.companyContactId,
    },
  });
  const address = {
    address1: "1 Ship St",
    city: "Toronto",
    zip: "M5V 1A1",
    countryCode: "CA",
    provinceCode: "ON",
    company: "Fake Co",
    firstName: "Ada",
    lastName: "Lovelace King",
  };
  expect(input.shippingAddress).toMatchObject(address);
  expect(input.billingAddress).toMatchObject(address); // no billing address → shipping is used
  expect(input.tags).toEqual([quoteTag(quote.id)]);
  expect(input.note).toBe(`Vendora Q-${quote.number} v1`);
  expect(input.appliedDiscount).toBeUndefined();
  expect((await load(quote.id)).syncStatus).toBe("SYNCED");
});

test("overrides and discounts are sent; a zero discount is not", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();
  await db.quoteLine.updateMany({
    where: { versionId: quote.currentVersionId! },
    data: { overridePrice: D("9.5"), discountPct: D(0) },
  });
  await db.quoteVersion.update({ where: { id: quote.currentVersionId! }, data: { quoteDiscountPct: D(5) } });

  await runSync(shopify.admin, upsert(quote.id));

  const input = shopify.drafts[0].input as { lineItems: Record<string, unknown>[]; appliedDiscount: unknown };
  expect(input.lineItems[0].priceOverride).toEqual({ amount: "9.50", currencyCode: "USD" });
  expect(input.lineItems[0].appliedDiscount).toBeUndefined();
  expect(input.appliedDiscount).toEqual({ valueType: "PERCENTAGE", value: 5, title: `Quote Q-${quote.number}` });
});

test("crash after Shopify created the order: retry adopts it, no duplicate", async () => {
  const shopify = fakeShopify({ crashAfterCreate: true });
  const quote = await queuedQuote();

  await expect(runSync(shopify.admin, upsert(quote.id))).rejects.toThrow("socket hang up");
  // Ambiguous failure: stays SYNCING and an early retry backs off.
  await expect(runSync(shopify.admin, upsert(quote.id))).rejects.toBeInstanceOf(SyncInFlight);

  await db.quote.update({
    where: { id: quote.id },
    data: { syncClaimedAt: new Date(Date.now() - STALE_MS - 1000) },
  });
  await runSync(shopify.admin, upsert(quote.id));

  expect(shopify.creates()).toBe(1);
  expect(shopify.calls.update).toBe(1); // adopted, then filled with the version
  const saved = await load(quote.id);
  expect(saved.syncStatus).toBe("SYNCED");
  expect(saved.draftOrderId).toBe(shopify.drafts[0].id);
  expect(await actions(quote.id)).toEqual(["sync.adopted"]);
});

test("B-1: our tag on another company's draft order: NEEDS_ATTENTION, nothing created or changed", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();
  shopify.seedDraft({
    tags: [quoteTag(quote.id)],
    companyId: "gid://shopify/Company/999",
    locationId: "gid://shopify/CompanyLocation/999",
  });

  await runSync(shopify.admin, upsert(quote.id));

  expect(shopify.creates()).toBe(0);
  expect(shopify.calls.update).toBe(0);
  const saved = await load(quote.id);
  expect(saved.syncStatus).toBe("NEEDS_ATTENTION");
  expect(saved.draftOrderId).toBeNull();
  expect(codes(saved.attention)).toEqual(["TAG_COLLISION"]);
});

test("a synced quote syncs again with an update, not a second draft order", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();
  await runSync(shopify.admin, upsert(quote.id));
  await db.quote.update({ where: { id: quote.id }, data: { syncStatus: "QUEUED" } });

  await runSync(shopify.admin, upsert(quote.id));

  expect(shopify.creates()).toBe(1);
  expect(shopify.calls.update).toBe(1);
});

test("Shopify rejects the input: FAILED with SYNC_FAILED", async () => {
  const shopify = fakeShopify({ createErrors: ["Variant is invalid"] });
  const quote = await queuedQuote();

  await runSync(shopify.admin, upsert(quote.id));

  const saved = await load(quote.id);
  expect(saved.syncStatus).toBe("FAILED");
  expect(saved.syncError).toBe("Variant is invalid");
  expect(codes(saved.attention)).toEqual(["SYNC_FAILED"]);
});

test("Shopify's subtotal differs by 1.00: PRICE_MISMATCH and no invoice queued", async () => {
  const shopify = fakeShopify({ subtotal: "1.00" });
  const quote = await queuedQuote();

  await runSync(shopify.admin, upsert(quote.id, { message: "Hi" }));

  const saved = await load(quote.id);
  expect(saved.syncStatus).toBe("NEEDS_ATTENTION");
  expect(saved.draftOrderId).not.toBeNull();
  expect(codes(saved.attention)).toEqual(["PRICE_MISMATCH"]);
  expect(enqueueMock).not.toHaveBeenCalled();
});

test("sync with send queues the invoice for this version", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();

  await runSync(shopify.admin, upsert(quote.id, { message: "Hi" }));

  expect(enqueueMock).toHaveBeenCalledWith(
    "send-invoice",
    { shop: SHOP, quoteId: quote.id, versionId: quote.currentVersionId, message: "Hi" },
    expect.objectContaining({ singletonKey: quote.currentVersionId }),
  );
});

test("another shop cannot sync the quote", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();

  await expect(runSync(shopify.admin, { ...upsert(quote.id), shop: "other-shop.myshopify.com" })).rejects.toThrow();

  expect(shopify.creates()).toBe(0);
  expect((await load(quote.id)).syncStatus).toBe("QUEUED");
});

test("a quote that isn't QUEUED is never synced without going through the queue", async () => {
  const shopify = fakeShopify();
  const quote = await testQuote(SHOP); // syncStatus NONE

  await runSync(shopify.admin, upsert(quote.id));

  expect(shopify.creates()).toBe(0);
  expect((await load(quote.id)).syncStatus).toBe("NONE");
});

test("cancel: the delete job removes the draft order", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();
  await runSync(shopify.admin, upsert(quote.id));

  await cancelQuote(staff(SHOP, shopify.admin), quote.id, "customer went elsewhere");
  expect(enqueueMock).toHaveBeenCalledWith(
    "sync-draft-order",
    { shop: SHOP, quoteId: quote.id, op: "delete" },
    expect.objectContaining({ singletonKey: `${quote.id}:delete` }),
  );
  await runSync(shopify.admin, { shop: SHOP, quoteId: quote.id, op: "delete" });

  expect(shopify.calls.delete).toBe(1);
  expect(shopify.drafts).toHaveLength(0);
  const saved = await load(quote.id);
  expect(saved.status).toBe("CANCELLED");
  expect(saved.draftOrderId).toBeNull();
  expect(saved.syncStatus).toBe("NONE");
});

test("an upsert that claims a cancelled quote deletes instead", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();
  await runSync(shopify.admin, upsert(quote.id));
  await db.quote.update({ where: { id: quote.id }, data: { status: "CANCELLED", syncStatus: "QUEUED" } });

  await runSync(shopify.admin, upsert(quote.id));

  expect(shopify.calls.update).toBe(0);
  expect(shopify.drafts).toHaveLength(0);
});

// send-invoice: an APPROVED quote whose version is synced to a draft order.
const syncedApprovedQuote = async (shopify: ReturnType<typeof fakeShopify>) => {
  const quote = await testQuote(SHOP, { overrides: { status: "APPROVED" } });
  const draft = shopify.seedDraft({ tags: [quoteTag(quote.id)], companyId: quote.companyId, locationId: quote.companyLocationId });
  await db.quote.update({ where: { id: quote.id }, data: { draftOrderId: draft.id, syncStatus: "SYNCED" } });
  return { shop: SHOP, quoteId: quote.id, versionId: quote.currentVersionId!, message: "Hi" };
};

test("send-invoice: one invoice, quote SENT", async () => {
  const shopify = fakeShopify();
  const job = await syncedApprovedQuote(shopify);

  await runSendInvoice(shopify.admin, job);

  expect(shopify.calls.invoice).toBe(1);
  const saved = await load(job.quoteId);
  expect(saved.status).toBe("SENT");
  expect(saved.invoiceSentVersionId).toBe(job.versionId);
});

test("send-invoice runs twice: one invoice", async () => {
  const shopify = fakeShopify();
  const job = await syncedApprovedQuote(shopify);

  await runSendInvoice(shopify.admin, job);
  await runSendInvoice(shopify.admin, job);

  expect(shopify.calls.invoice).toBe(1);
});

test("send-invoice crashes after Shopify sent it: the retry doesn't send again", async () => {
  const crashing = fakeShopify({ crashAfterInvoice: true });
  const job = await syncedApprovedQuote(crashing);

  await expect(runSendInvoice(crashing.admin, job)).rejects.toThrow("socket hang up");
  expect((await load(job.quoteId)).status).toBe("APPROVED");
  await runSendInvoice(crashing.admin, job);

  expect(crashing.calls.invoice).toBe(1);
  expect((await load(job.quoteId)).status).toBe("SENT");
});

test("send-invoice: contact without email → INVOICE_FAILED, stays APPROVED", async () => {
  const shopify = fakeShopify({ contactEmail: null });
  const job = await syncedApprovedQuote(shopify);

  await runSendInvoice(shopify.admin, job);

  expect(shopify.calls.invoice).toBe(0);
  const saved = await load(job.quoteId);
  expect(saved.status).toBe("APPROVED");
  expect(saved.invoiceSentVersionId).toBeNull();
  expect(codes(saved.attention)).toEqual(["INVOICE_FAILED"]);
});
