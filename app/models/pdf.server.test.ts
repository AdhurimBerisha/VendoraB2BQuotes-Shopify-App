import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../db.server";
import { NotFoundError } from "../lib/errors";
import { D } from "../lib/money";
import { fakeShopify } from "../test/fake-shopify";
import { testQuote, testShop } from "../test/factories";
import { type QuotePdfData, loadQuotePdfData, renderQuotePdf } from "./pdf.server";
import { redactShop } from "./privacy.server";
import { isAllowedLogoUrl } from "./shop.server";

const shopify = fakeShopify();
let SHOP: string;

beforeAll(async () => {
  SHOP = (await testShop()).id;
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

// PDF data with `lines` generated lines and names in several scripts.
const pdfData = async (lines: number, title = (i: number) => `Snowboard ${i}`): Promise<QuotePdfData> => {
  const quote = await testQuote(SHOP, { lines });
  await db.quoteLine.updateMany({ where: { versionId: quote.currentVersionId! }, data: { discountPct: D(5) } });
  const data = await loadQuotePdfData(shopify.admin, SHOP, quote.id);
  return { ...data, lines: data.lines.map((line, i) => ({ ...line, title: title(i) })) };
};

test("a 3-line quote renders a PDF", async () => {
  const pdf = await renderQuotePdf(await pdfData(3));

  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  expect(pdf.length).toBeGreaterThan(1024);
});

test("200 lines render in under 2 s, on more than one page", async () => {
  const data = await pdfData(200);
  const started = Date.now();

  const pdf = await renderQuotePdf(data);

  expect(Date.now() - started).toBeLessThan(2000);
  const pages = pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? [];
  expect(pages.length).toBeGreaterThan(1);
});

test("names with ë, ç, ü, Greek and Arabic render without throwing", async () => {
  const names = ["Këpucë çizme", "Grüne Ski", "Χιονοσανίδα", "لوح التزلج", "Snowboard 日本"];
  const pdf = await renderQuotePdf(await pdfData(names.length, (i) => names[i]));

  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
});

test("another shop's quote is not found", async () => {
  const quote = await testQuote(SHOP);

  await expect(loadQuotePdfData(shopify.admin, "other-shop.myshopify.com", quote.id)).rejects.toBeInstanceOf(NotFoundError);
});

test("an older version shows its own lines, not the current ones", async () => {
  const quote = await testQuote(SHOP, { lines: 1 });
  const v2 = await db.quoteVersion.create({
    data: {
      quoteId: quote.id,
      versionNumber: 2,
      lines: {
        create: [0, 1, 2].map((position) => ({
          position,
          variantId: `gid://shopify/ProductVariant/${position + 10}`,
          productId: `gid://shopify/Product/${position + 10}`,
          titleSnapshot: `v2 line ${position}`,
          quantity: 1,
          catalogPrice: D(10),
          lineTotal: D(10),
        })),
      },
    },
  });
  await db.quote.update({ where: { id: quote.id }, data: { currentVersionId: v2.id } });

  const v1 = await loadQuotePdfData(shopify.admin, SHOP, quote.id, 1);
  const current = await loadQuotePdfData(shopify.admin, SHOP, quote.id);

  expect(v1.version).toBe(1);
  expect(v1.lines.map((line) => line.title)).toEqual(["Product 1"]);
  expect(current.version).toBe(2);
  expect(current.lines).toHaveLength(3);
  await expect(loadQuotePdfData(shopify.admin, SHOP, quote.id, 9)).rejects.toBeInstanceOf(NotFoundError);
});

test("logo URLs: only Shopify's file CDN over https (SSRF)", () => {
  expect(isAllowedLogoUrl("https://cdn.shopify.com/s/files/1/0001/logo.png")).toBe(true);
  for (const url of [
    "http://cdn.shopify.com/logo.png",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/logo.png",
    "https://cdn.shopify.com.evil.example/logo.png",
    "https://user@cdn.shopify.com/logo.png",
    "https://cdn.shopify.com:8443/logo.png",
    "file:///etc/passwd",
    "not a url",
  ]) {
    expect(isAllowedLogoUrl(url)).toBe(false);
  }
});

test("a stored logo URL on another host is never fetched", async () => {
  await db.shop.update({ where: { id: SHOP }, data: { logoUrl: "https://10.0.0.1/logo.png" } });
  const quote = await testQuote(SHOP);

  expect((await loadQuotePdfData(shopify.admin, SHOP, quote.id)).logoUrl).toBeNull();
  await db.shop.update({ where: { id: SHOP }, data: { logoUrl: null } });
});
