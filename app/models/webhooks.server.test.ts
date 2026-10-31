import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../db.server";
import { UserError } from "../lib/errors";
import { D } from "../lib/money";
import { fakeShopify } from "../test/fake-shopify";
import { staff, testQuote, testShop } from "../test/factories";
import type { AttentionItem } from "./attention";
import { redactShop } from "./privacy.server";
import { sendQuote } from "./sync.server";
import { processWebhook } from "./webhooks.server";

let SHOP: string;
let nextDraft = 5000;

beforeAll(async () => {
  SHOP = (await testShop()).id;
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

const load = (id: string) => db.quote.findUniqueOrThrow({ where: { id } });
const codes = (attention: unknown) => ((attention as AttentionItem[] | null) ?? []).map((item) => item.code);

// A SENT quote synced to draft order `draftNumber` (1 line: variant 1 × 2), last seen at `syncedAt`.
const sentQuote = async (syncedAt = new Date("2026-10-31T10:00:00Z")) => {
  const draftNumber = nextDraft++;
  const quote = await testQuote(SHOP, { overrides: { status: "SENT", syncStatus: "SYNCED" } });
  await db.quote.update({
    where: { id: quote.id },
    data: {
      draftOrderId: `gid://shopify/DraftOrder/${draftNumber}`,
      syncedVersionId: quote.currentVersionId,
      shopifyUpdatedAt: syncedAt,
    },
  });
  return { quote, draftNumber };
};

const draftPayload = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  status: "invoice_sent",
  order_id: null,
  updated_at: "2026-10-31T11:00:00Z",
  line_items: [{ variant_id: 1, quantity: 2 }],
  ...overrides,
});

test("completed draft order: quote ORDERED with the order id", async () => {
  const { quote, draftNumber } = await sentQuote();

  await processWebhook("DRAFT_ORDERS_UPDATE", SHOP, draftPayload(draftNumber, { status: "completed", order_id: 77 }));

  const saved = await load(quote.id);
  expect(saved.status).toBe("ORDERED");
  expect(saved.orderId).toBe("gid://shopify/Order/77");
});

test("an APPROVED quote whose draft order is completed in Shopify is ORDERED too", async () => {
  const { quote, draftNumber } = await sentQuote();
  await db.quote.update({ where: { id: quote.id }, data: { status: "APPROVED" } });

  await processWebhook("DRAFT_ORDERS_UPDATE", SHOP, draftPayload(draftNumber, { status: "completed", order_id: 78 }));

  expect((await load(quote.id)).status).toBe("ORDERED");
});

test("order on a cancelled quote: keeps the order id, raises ORDER_ON_CLOSED_QUOTE", async () => {
  const { quote, draftNumber } = await sentQuote();
  await db.quote.update({ where: { id: quote.id }, data: { status: "CANCELLED" } });

  await processWebhook("DRAFT_ORDERS_UPDATE", SHOP, draftPayload(draftNumber, { status: "completed", order_id: 79 }));

  const saved = await load(quote.id);
  expect(saved.status).toBe("CANCELLED");
  expect(saved.orderId).toBe("gid://shopify/Order/79");
  expect(codes(saved.attention)).toEqual(["ORDER_ON_CLOSED_QUOTE"]);
});

test("scenario 6: the same payload twice, or an older one, is ignored", async () => {
  const { quote, draftNumber } = await sentQuote();
  const edited = draftPayload(draftNumber, { line_items: [{ variant_id: 1, quantity: 5 }] });

  await processWebhook("DRAFT_ORDERS_UPDATE", SHOP, edited);
  await db.quote.update({ where: { id: quote.id }, data: { attention: Prisma.DbNull, syncStatus: "SYNCED" } });
  await processWebhook("DRAFT_ORDERS_UPDATE", SHOP, edited);
  await processWebhook("DRAFT_ORDERS_UPDATE", SHOP, { ...edited, updated_at: "2026-10-31T09:00:00Z" });

  const saved = await load(quote.id);
  expect(saved.attention).toBeNull();
  expect(saved.syncStatus).toBe("SYNCED");
});

test("same lines (e.g. our own invoice send): nothing raised", async () => {
  const { quote, draftNumber } = await sentQuote();

  await processWebhook("DRAFT_ORDERS_UPDATE", SHOP, draftPayload(draftNumber));

  const saved = await load(quote.id);
  expect(saved.attention).toBeNull();
  expect(saved.shopifyUpdatedAt).toEqual(new Date("2026-10-31T11:00:00Z"));
});

test("scenario 16: lines changed in Shopify → CHANGED_IN_SHOPIFY", async () => {
  const { quote, draftNumber } = await sentQuote();

  await processWebhook("DRAFT_ORDERS_UPDATE", SHOP, draftPayload(draftNumber, { line_items: [{ variant_id: 1, quantity: 3 }] }));

  const saved = await load(quote.id);
  expect(saved.syncStatus).toBe("NEEDS_ATTENTION");
  expect(codes(saved.attention)).toEqual(["CHANGED_IN_SHOPIFY"]);
});

test("no line check while our own sync is writing the draft order", async () => {
  const { quote, draftNumber } = await sentQuote();
  await db.quote.update({ where: { id: quote.id }, data: { syncStatus: "SYNCING" } });

  await processWebhook("DRAFT_ORDERS_UPDATE", SHOP, draftPayload(draftNumber, { line_items: [{ variant_id: 9, quantity: 1 }] }));

  expect((await load(quote.id)).attention).toBeNull();
});

test("draft order deleted while SENT → DRAFT_DELETED, draftOrderId cleared", async () => {
  const { quote, draftNumber } = await sentQuote();

  await processWebhook("DRAFT_ORDERS_DELETE", SHOP, { id: draftNumber });

  const saved = await load(quote.id);
  expect(saved.draftOrderId).toBeNull();
  expect(saved.syncStatus).toBe("NEEDS_ATTENTION");
  expect(codes(saved.attention)).toEqual(["DRAFT_DELETED"]);
});

test("scenario 9: product deleted → current-version lines flagged, old versions untouched, send blocked", async () => {
  const quote = await testQuote(SHOP, { overrides: { status: "APPROVED" } });
  const oldVersionId = quote.currentVersionId!;
  const current = await db.quoteVersion.create({
    data: {
      quoteId: quote.id,
      versionNumber: 2,
      lines: {
        create: {
          position: 0,
          variantId: "gid://shopify/ProductVariant/1",
          productId: "gid://shopify/Product/1",
          titleSnapshot: "Product 1",
          quantity: 2,
          catalogPrice: D(10),
          lineTotal: D(20),
        },
      },
    },
  });
  await db.quote.update({ where: { id: quote.id }, data: { currentVersionId: current.id } });

  await processWebhook("PRODUCTS_DELETE", SHOP, { id: 1 });

  const [currentLine] = await db.quoteLine.findMany({ where: { versionId: current.id } });
  const [oldLine] = await db.quoteLine.findMany({ where: { versionId: oldVersionId } });
  expect(currentLine.problems).toEqual(["PRODUCT_DELETED"]);
  expect(oldLine.problems).toBeNull();
  expect(codes((await load(quote.id)).attention)).toEqual(["PRODUCT_DELETED"]);
  await expect(sendQuote(staff(SHOP, fakeShopify().admin), quote.id, "Hi")).rejects.toThrow(UserError);
});

test("products/update to archived → PRODUCT_NOT_ACTIVE; an active update changes nothing", async () => {
  const quote = await testQuote(SHOP, { overrides: { status: "DRAFT" } });

  await processWebhook("PRODUCTS_UPDATE", SHOP, { id: 1, status: "active" });
  expect((await load(quote.id)).attention).toBeNull();
  await processWebhook("PRODUCTS_UPDATE", SHOP, { id: 1, status: "archived" });

  const [line] = await db.quoteLine.findMany({ where: { versionId: quote.currentVersionId! } });
  expect(line.problems).toEqual(["PRODUCT_NOT_ACTIVE"]);
});
