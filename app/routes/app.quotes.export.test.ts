import Papa from "papaparse";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../db.server";
import { redactShop } from "../models/privacy.server";
import { fakeShopify } from "../test/fake-shopify";
import { staff, testQuote, testShop } from "../test/factories";
import { loader } from "./app.quotes.export";

// M5.3 (G-11): Settings → Export all quotes. One row per line, own shop only.
let SHOP: string;
let OTHER: string;
const shopify = fakeShopify();
let userId = 1n; // the staff member exporting
vi.mock("../models/actor.server", () => ({ getActor: vi.fn(async () => staff(SHOP, shopify.admin, "OWNER", userId)) }));

beforeAll(async () => {
  SHOP = (await testShop()).id;
  OTHER = (await testShop()).id;
});

afterAll(async () => {
  await redactShop(SHOP);
  await redactShop(OTHER);
  await db.$disconnect();
});

const exportRows = async (query: string) => {
  const response = await loader({
    request: new Request(`https://vendora.test/app/quotes/export${query}`),
    params: {},
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
  const text = (await response.text()).replace(/^\uFEFF/, "");
  return Papa.parse<Record<string, string>>(text, { header: true }).data;
};

test("the full export has one row per line and only this shop's quotes", async () => {
  const mine = await testQuote(SHOP, { lines: 2 });
  const theirs = await testQuote(OTHER, { lines: 3 });

  const rows = await exportRows("?lines=1");

  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.quoteId)).toEqual([mine.id, mine.id]);
  expect(rows.map((row) => row.sku)).toEqual(["SKU-1", "SKU-2"]);
  expect(rows[0]).toMatchObject({
    company: "Company 1",
    companyId: "gid://shopify/Company/1",
    product: "Product 1",
    quantity: "2",
    unitPrice: "10.00",
    lineTotal: "20.00",
  });
  expect(JSON.stringify(rows)).not.toContain(theirs.id);
  // M5.4 access log: the export is in this shop's history.
  const logged = await db.auditEvent.findFirstOrThrow({ where: { shop: SHOP, action: "data.exported" } });
  expect(logged.data).toEqual({ quotes: 1, rows: 2, withLines: true });
});

test("the list export stays one row per quote, without the line columns", async () => {
  const rows = await exportRows("");
  expect(rows).toHaveLength(1);
  expect(rows[0]).not.toHaveProperty("sku");
});

test("a store that lost B2B still exports, without company names", async () => {
  shopify.failNext("VendoraCompanyNames", "accessDenied");
  // companyNames caches per shop for 5 minutes: a different company id forces a real call.
  await db.quote.updateMany({ where: { shop: SHOP }, data: { companyId: "gid://shopify/Company/2" } });

  const rows = await exportRows("?lines=1");

  expect(rows).toHaveLength(2);
  expect(rows[0].company).toBe("");
  expect((await db.shop.findUniqueOrThrow({ where: { id: SHOP } })).b2bUnavailable).toBe(true);
});

test("M10.2: cost columns only for staff Shopify lets see costs", async () => {
  const quote = await testQuote(SHOP, { lines: 1 });
  await db.quoteLine.updateMany({ where: { version: { quoteId: quote.id } }, data: { unitCost: "6" } });

  const rows = (await exportRows("?lines=1")).filter((row) => row.quoteId === quote.id);
  expect(rows[0]).toMatchObject({ unitCost: "6.00" });
  expect(rows[0].marginPct).toMatch(/^\d+(\.\d)?$/);

  // Another staff member whose Shopify account can't view product costs.
  userId = 99n;
  shopify.failNext("VendoraCanViewCosts", "accessDenied");
  const hidden = await exportRows("?lines=1");
  userId = 1n;
  expect(hidden[0]).not.toHaveProperty("unitCost");
  expect(hidden[0]).not.toHaveProperty("marginPct");
});
