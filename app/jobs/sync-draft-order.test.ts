import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../db.server";
import { redactShop } from "../models/privacy.server";
import { ConversionInFlight, STALE_MS } from "../models/quote.server";
import { fakeShopify } from "../test/fake-shopify";
import { runSyncDraftOrder } from "./sync-draft-order.server";

const SHOP = `vitest-${randomUUID()}.myshopify.com`;
const UNINSTALLED_SHOP = `vitest-${randomUUID()}.myshopify.com`;

beforeAll(async () => {
  await db.shop.create({ data: { id: SHOP } });
  await db.shop.create({ data: { id: UNINSTALLED_SHOP, uninstalledAt: new Date() } });
});

afterAll(async () => {
  await redactShop(SHOP);
  await redactShop(UNINSTALLED_SHOP);
  await db.$disconnect();
});

const queuedQuote = (shop = SHOP) =>
  db.quote.create({
    data: {
      shop,
      status: "QUEUED",
      companyId: "gid://shopify/Company/1",
      companyLocationId: "gid://shopify/CompanyLocation/1",
      companyContactId: "gid://shopify/CompanyContact/1",
      lines: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
    },
  });

const depsFor = (shopify: ReturnType<typeof fakeShopify>) => ({
  getAdmin: async () => shopify.admin,
});

test("success: quote CONVERTED with one draft order", async () => {
  const shopify = fakeShopify();
  const quote = await queuedQuote();

  await runSyncDraftOrder({ shop: SHOP, quoteId: quote.id }, depsFor(shopify));

  const saved = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
  expect(saved.status).toBe("CONVERTED");
  expect(shopify.creates()).toBe(1);
});

test("network error, then a retry after the stale window: CONVERTED, still one create", async () => {
  const shopify = fakeShopify({ crashAfterCreate: true });
  const quote = await queuedQuote();
  const job = { shop: SHOP, quoteId: quote.id };

  await expect(runSyncDraftOrder(job, depsFor(shopify))).rejects.toThrow("socket hang up");
  await db.quote.update({
    where: { id: quote.id },
    data: { updatedAt: new Date(Date.now() - STALE_MS - 1000) },
  });
  await runSyncDraftOrder(job, depsFor(shopify));

  const saved = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
  expect(saved.status).toBe("CONVERTED");
  expect(shopify.creates()).toBe(1);
});

test("early retry throws ConversionInFlight so pg-boss tries again later", async () => {
  const shopify = fakeShopify({ crashAfterCreate: true });
  const quote = await queuedQuote();
  const job = { shop: SHOP, quoteId: quote.id };

  await expect(runSyncDraftOrder(job, depsFor(shopify))).rejects.toThrow("socket hang up");
  await expect(runSyncDraftOrder(job, depsFor(shopify))).rejects.toBeInstanceOf(
    ConversionInFlight,
  );
});

test("uninstalled shop: no Shopify call, quote untouched", async () => {
  const shopify = fakeShopify();
  let adminRequested = false;
  const quote = await queuedQuote(UNINSTALLED_SHOP);

  await runSyncDraftOrder(
    { shop: UNINSTALLED_SHOP, quoteId: quote.id },
    {
      getAdmin: async () => {
        adminRequested = true;
        return shopify.admin;
      },
    },
  );

  expect(adminRequested).toBe(false);
  expect(shopify.creates()).toBe(0);
  const saved = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
  expect(saved.status).toBe("QUEUED");
});
