import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../db.server";
import { enqueue } from "../jobs/queue.server";
import { UserError } from "../lib/errors";
import { quoteTag } from "../shopify/draft-orders.server";
import { fakeShopify } from "../test/fake-shopify";
import { staff, testQuote, testShop } from "../test/factories";
import type { AttentionItem } from "./attention";
import { parseLinesKey, resolveAttention } from "./attention-actions.server";
import { redactShop } from "./privacy.server";

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

const load = (id: string) => db.quote.findUniqueOrThrow({ where: { id } });
const codes = (attention: unknown) => ((attention as AttentionItem[] | null) ?? []).map((item) => item.code);
const withAttention = async (overrides: object, item: Omit<AttentionItem, "at">) => {
  const quote = await testQuote(SHOP, { overrides: { status: "APPROVED", syncStatus: "NEEDS_ATTENTION", ...overrides } });
  await db.quote.update({ where: { id: quote.id }, data: { attention: [{ ...item, at: new Date().toISOString() }] } });
  return quote;
};
const syncJobs = () => enqueueMock.mock.calls.filter(([name]) => name === "sync-draft-order");

test("TAG_COLLISION → create new: our tag leaves the other company's draft, a fresh sync is queued, audited", async () => {
  const shopify = fakeShopify();
  const quote = await testQuote(SHOP, { overrides: { status: "APPROVED" } });
  const other = shopify.seedDraft({ tags: [quoteTag(quote.id), "theirs"], companyId: "gid://shopify/Company/99", locationId: "gid://shopify/CompanyLocation/99" });
  await db.quote.update({
    where: { id: quote.id },
    data: {
      syncStatus: "NEEDS_ATTENTION",
      attention: [{ code: "TAG_COLLISION", data: { draftOrderIds: [other.id] }, at: new Date().toISOString() }],
    },
  });

  await resolveAttention(staff(SHOP, shopify.admin, "MANAGER"), quote.id, "TAG_COLLISION", "createNew");

  expect(other.tags).toEqual(["theirs"]);
  const saved = await load(quote.id);
  expect(saved.syncStatus).toBe("QUEUED");
  expect(saved.attention).toBeNull();
  expect(syncJobs()).toHaveLength(1);
  const [event] = await db.auditEvent.findMany({ where: { quoteId: quote.id, action: "attention.resolved" } });
  expect(event.data).toEqual({ code: "TAG_COLLISION", action: "createNew" });
});

test("RETRIES_EXHAUSTED → retry queues the sync again", async () => {
  const quote = await withAttention({}, { code: "RETRIES_EXHAUSTED", message: "socket hang up" });

  await resolveAttention(staff(SHOP, fakeShopify().admin), quote.id, "RETRIES_EXHAUSTED", "retry");

  expect((await load(quote.id)).syncStatus).toBe("QUEUED");
  expect(syncJobs()).toHaveLength(1);
});

test("CHANGED_IN_SHOPIFY → keep Shopify's version: a new DRAFT version with the draft order's lines", async () => {
  const shopify = fakeShopify({
    variants: { "gid://shopify/ProductVariant/1": { price: "10.00" }, "gid://shopify/ProductVariant/7": { price: "3.00" } },
  });
  const quote = await withAttention(
    { status: "SENT", syncStatus: "NEEDS_ATTENTION" },
    { code: "CHANGED_IN_SHOPIFY", data: { ours: "gid://shopify/ProductVariant/1:2", theirs: "gid://shopify/ProductVariant/1:5|gid://shopify/ProductVariant/7:1" } },
  );

  await resolveAttention(staff(SHOP, shopify.admin), quote.id, "CHANGED_IN_SHOPIFY", "acceptShopify");

  const saved = await db.quote.findUniqueOrThrow({
    where: { id: quote.id },
    include: { currentVersion: { include: { lines: { orderBy: { position: "asc" } } } } },
  });
  expect(saved.status).toBe("DRAFT");
  expect(saved.currentVersion?.versionNumber).toBe(2);
  expect(saved.currentVersion?.lines.map((line) => [line.variantId, line.quantity])).toEqual([
    ["gid://shopify/ProductVariant/1", 5],
    ["gid://shopify/ProductVariant/7", 1],
  ]);
  expect(codes(saved.attention)).toEqual([]);
});

test("an action that doesn't belong to the code, or an item already gone, is refused", async () => {
  const quote = await withAttention({}, { code: "PRICE_MISMATCH" });
  const actor = staff(SHOP, fakeShopify().admin);

  await expect(resolveAttention(actor, quote.id, "PRICE_MISMATCH", "retry")).rejects.toThrow(UserError);
  await resolveAttention(actor, quote.id, "PRICE_MISMATCH", "dismiss");
  expect((await load(quote.id)).attention).toBeNull();
  await expect(resolveAttention(actor, quote.id, "PRICE_MISMATCH", "dismiss")).rejects.toThrow("attention.errors.gone");
});

test("a rep can't resolve; another shop's quote is not found", async () => {
  const quote = await withAttention({}, { code: "PRICE_MISMATCH" });
  const otherShop = (await testShop()).id;
  try {
    await expect(resolveAttention(staff(SHOP, fakeShopify().admin, "REP"), quote.id, "PRICE_MISMATCH", "dismiss")).rejects.toThrow(
      "errors.forbidden",
    );
    await expect(resolveAttention(staff(otherShop, fakeShopify().admin), quote.id, "PRICE_MISMATCH", "dismiss")).rejects.toThrow(
      "errors.notFound",
    );
  } finally {
    await redactShop(otherShop);
  }
});

test("parseLinesKey ignores anything that isn't a variant with a positive quantity", () => {
  expect(parseLinesKey("gid://shopify/ProductVariant/1:2|bad|gid://shopify/Product/3:1|gid://shopify/ProductVariant/4:0")).toEqual([
    { variantId: "gid://shopify/ProductVariant/1", quantity: 2 },
  ]);
});
