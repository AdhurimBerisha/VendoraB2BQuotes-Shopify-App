import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../db.server";
import { ConflictError, NotFoundError, UserError } from "../lib/errors";
import { D } from "../lib/money";
import { findVariantsBySku, getVariantPrices } from "../shopify/products.server";
import { type FakeVariant, fakeShopify } from "../test/fake-shopify";
import { staff, testQuote, testShop } from "../test/factories";
import { MAX_ROWS, commitImport, parseCsv, startImport, validateRows } from "./import.server";
import { redactShop } from "./privacy.server";

vi.mock("../jobs/queue.server", () => ({ enqueue: vi.fn(async () => "job-id"), getBoss: vi.fn(async () => ({})) }));

const FIXTURES = "app/test/fixtures";
const MIN = "gid://shopify/ProductVariant/101";
const HYD = "gid://shopify/ProductVariant/105";
const VARIANTS: Record<string, FakeVariant> = {
  [MIN]: { price: "10.00", sku: "SNOW-MIN-01" },
  "gid://shopify/ProductVariant/102": { price: "20.00", sku: "SNOW-VID-01" },
  "gid://shopify/ProductVariant/103": { price: "30.00", sku: "SNOW-ARCH-01", status: "ARCHIVED" },
  "gid://shopify/ProductVariant/104": { price: "10.00", sku: "GIFT-10", isGiftCard: true },
  [HYD]: { price: "600.00", sku: "SNOW-HYD-01" },
  "gid://shopify/ProductVariant/106": { price: "5.00", sku: "STEP-5", quantityRule: { minimum: 5, maximum: null, increment: 5 } },
};
const shopify = fakeShopify({ variants: VARIANTS });

let SHOP: string;

beforeAll(async () => {
  SHOP = (await testShop()).id;
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

const deps = (fake = shopify) => ({
  findBySku: (skus: string[]) => findVariantsBySku(fake.admin, skus),
  prices: (ids: string[]) => getVariantPrices(fake.admin, ids, "gid://shopify/CompanyLocation/1"),
  currency: "USD",
});
const fixture = (name: string) => readFileSync(`${FIXTURES}/${name}`, "utf8");
const csvFile = (text: string, name = "lines.csv") => new File([text], name, { type: "text/csv" });

test("scenario 10: the report matches the fixture exactly", async () => {
  const { lines, report } = await validateRows(parseCsv(fixture("scenario-10.csv")), deps());

  expect(report).toEqual(JSON.parse(fixture("scenario-10.expected.json")));
  expect(lines).toEqual([
    { variantId: MIN, quantity: 15, overridePrice: null, discountPct: null },
    { variantId: HYD, quantity: 2, overridePrice: "550", discountPct: "5" },
  ]);
});

test("scenario 10 upload writes nothing to the quote", async () => {
  const quote = await testQuote(SHOP);
  const actor = staff(SHOP, shopify.admin);

  const imp = await startImport(actor, quote.id, csvFile(fixture("scenario-10.csv")));

  expect(imp.status).toBe("READY");
  expect(await db.quoteLine.count({ where: { versionId: quote.currentVersionId! } })).toBe(1);
});

test("commit (append) adds the valid lines next to the existing ones, with an audit event", async () => {
  const quote = await testQuote(SHOP); // 1 line: ProductVariant/1 × 2
  const actor = staff(SHOP, fakeShopify({ variants: { ...VARIANTS, "gid://shopify/ProductVariant/1": { price: "10.00" } } }).admin);
  const imp = await startImport(actor, quote.id, csvFile(fixture("scenario-10.csv")));

  await commitImport(actor, imp.id, "append");

  const lines = await db.quoteLine.findMany({ where: { versionId: quote.currentVersionId! }, orderBy: { position: "asc" } });
  expect(lines.map((line) => [line.variantId, line.quantity])).toEqual([
    ["gid://shopify/ProductVariant/1", 2],
    [MIN, 15],
    [HYD, 2],
  ]);
  expect(lines[2].overridePrice?.toString()).toBe("550");
  expect(lines[2].discountPct?.toString()).toBe("5");
  const events = await db.auditEvent.findMany({ where: { quoteId: quote.id, action: "import.committed" } });
  expect(events).toHaveLength(1);
  await expect(commitImport(actor, imp.id, "append")).rejects.toBeInstanceOf(ConflictError); // committed once
});

test("commit (append) where SNOW-MIN-01 is already on the quote × 5: quantity becomes 20", async () => {
  const quote = await testQuote(SHOP);
  await db.quoteLine.updateMany({ where: { versionId: quote.currentVersionId! }, data: { variantId: MIN, quantity: 5 } });
  const actor = staff(SHOP, shopify.admin);
  const imp = await startImport(actor, quote.id, csvFile(fixture("scenario-10.csv")));

  await commitImport(actor, imp.id, "append");

  const line = await db.quoteLine.findFirstOrThrow({ where: { versionId: quote.currentVersionId!, variantId: MIN } });
  expect(line.quantity).toBe(20);
});

test("commit (replace) keeps only the imported lines", async () => {
  const quote = await testQuote(SHOP);
  const actor = staff(SHOP, shopify.admin);
  const imp = await startImport(actor, quote.id, csvFile(fixture("scenario-10.csv")));

  await commitImport(actor, imp.id, "replace");

  const lines = await db.quoteLine.findMany({ where: { versionId: quote.currentVersionId! } });
  expect(lines.map((line) => line.variantId).sort()).toEqual([MIN, HYD].sort());
});

test("duplicate rows with different prices: both rows DUPLICATE_CONFLICT", async () => {
  const { lines, report } = await validateRows(parseCsv("sku,quantity,price\nSNOW-MIN-01,1,9\nsnow-min-01,2,8\n"), deps());

  expect(lines).toEqual([]);
  expect(report.rows.map((row) => [row.row, row.status, row.codes])).toEqual([
    [2, "ERROR", ["DUPLICATE_CONFLICT"]],
    [3, "ERROR", ["DUPLICATE_CONFLICT"]],
  ]);
});

test("semicolons, BOM, CRLF and a quoted field with a comma parse like the plain file", () => {
  const plain = parseCsv("sku,quantity,price\nSNOW-MIN-01,3,\"12.5\"\nSNOW-HYD-01,2,\n");
  const messy = parseCsv("\uFEFFsku;quantity;price\r\n\"SNOW-MIN-01\";3;\"12,5\"\r\nSNOW-HYD-01;2;\r\n");
  const quotedComma = parseCsv("sku,quantity,discount\n\"SNOW,01\",3,5%\n");

  expect(messy.map((row) => [row.row, row.sku, row.quantity])).toEqual(plain.map((row) => [row.row, row.sku, row.quantity]));
  expect(messy[0].price).toBe("12,5");
  expect(quotedComma[0]).toMatchObject({ sku: "SNOW,01", discount: "5" });
});

test("header aliases (Item Code;Qty) work", async () => {
  const { lines } = await validateRows(parseCsv("Item Code;Qty\nSNOW-HYD-01;4\n"), deps());

  expect(lines).toEqual([{ variantId: HYD, quantity: 4, overridePrice: null, discountPct: null }]);
});

test("a missing quantity column is rejected", () => {
  expect(() => parseCsv("sku,price\nSNOW-MIN-01,1\n")).toThrow(new UserError("import.errors.missingColumns"));
});

test("10 001 rows are rejected", () => {
  const text = `sku,quantity\n${"A,1\n".repeat(MAX_ROWS + 1)}`;
  expect(() => parseCsv(text)).toThrow(new UserError("import.errors.tooManyRows", { max: MAX_ROWS }));
});

test("10 000 distinct rows validate in under 60 s with the fake Shopify", async () => {
  const variants: Record<string, FakeVariant> = {};
  const rows: string[] = [];
  for (let i = 1; i <= MAX_ROWS; i++) {
    variants[`gid://shopify/ProductVariant/${i}`] = { price: "1.00", sku: `BULK-${i}` };
    rows.push(`BULK-${i},1`);
  }
  const started = Date.now();

  const { report } = await validateRows(parseCsv(`sku,quantity\n${rows.join("\n")}\n`), deps(fakeShopify({ variants })));

  expect(report.summary.lines).toBe(MAX_ROWS);
  expect(Date.now() - started).toBeLessThan(60_000);
}, 60_000);

test("quantity rule min 5, increment 5 with qty 7 → QTY_NOT_INCREMENT", async () => {
  const { report } = await validateRows(parseCsv("sku,quantity\nSTEP-5,7\n"), deps());

  expect(report.rows[0]).toMatchObject({ status: "ERROR", codes: ["QTY_NOT_INCREMENT"] });
});

test("another shop's import can't be committed", async () => {
  const quote = await testQuote(SHOP);
  const imp = await startImport(staff(SHOP, shopify.admin), quote.id, csvFile(fixture("scenario-10.csv")));

  await expect(commitImport(staff("other-shop.myshopify.com", shopify.admin), imp.id, "append")).rejects.toBeInstanceOf(
    NotFoundError,
  );
  expect((await db.import.findUniqueOrThrow({ where: { id: imp.id } })).status).toBe("READY");
});

test("a locked version can't receive an import", async () => {
  const quote = await testQuote(SHOP);
  await db.quoteVersion.update({ where: { id: quote.currentVersionId! }, data: { lockedAt: new Date(), total: D(0) } });

  await expect(startImport(staff(SHOP, shopify.admin), quote.id, csvFile("sku,quantity\nSNOW-MIN-01,1\n"))).rejects.toThrow(
    new UserError("quote.errors.versionLocked"),
  );
});
