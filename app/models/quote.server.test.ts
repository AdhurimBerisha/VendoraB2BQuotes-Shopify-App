import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import db from "../db.server";
import { fakeShopify } from "../test/fake-shopify";
import { STALE_MS, convertQuote } from "./quote.server";

const SHOP = `vitest-${randomUUID()}.myshopify.com`;

afterAll(async () => {
  await db.quote.deleteMany({ where: { shop: SHOP } });
  await db.$disconnect();
});

const newQuote = () =>
  db.quote.create({
    data: {
      shop: SHOP,
      companyId: "gid://shopify/Company/1",
      companyLocationId: "gid://shopify/CompanyLocation/1",
      companyContactId: "gid://shopify/CompanyContact/1",
      lines: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 2 }],
    },
  });

test("quote accepted twice at once creates one draft order", async () => {
  const shopify = fakeShopify();
  const quote = await newQuote();

  await Promise.all([
    convertQuote(shopify.admin, SHOP, quote.id),
    convertQuote(shopify.admin, SHOP, quote.id),
  ]);

  expect(shopify.creates()).toBe(1);
  const saved = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
  expect(saved.status).toBe("CONVERTED");
  expect(saved.draftOrderId).toBe(shopify.drafts[0].id);
});

test("crash after Shopify created the order: retry adopts it, no duplicate", async () => {
  const shopify = fakeShopify({ crashAfterCreate: true });
  const quote = await newQuote();

  await expect(convertQuote(shopify.admin, SHOP, quote.id)).rejects.toThrow();
  // Ambiguous failure: stays CONVERTING and an immediate retry is a no-op.
  expect((await convertQuote(shopify.admin, SHOP, quote.id)).status).toBe(
    "CONVERTING",
  );

  await db.quote.update({
    where: { id: quote.id },
    data: { updatedAt: new Date(Date.now() - STALE_MS - 1000) },
  });
  const saved = await convertQuote(shopify.admin, SHOP, quote.id);

  expect(shopify.creates()).toBe(1);
  expect(saved.status).toBe("CONVERTED");
  expect(saved.draftOrderId).toBe(shopify.drafts[0].id);
});

test("another shop cannot convert the quote", async () => {
  const shopify = fakeShopify();
  const quote = await newQuote();

  await expect(
    convertQuote(shopify.admin, "other-shop.myshopify.com", quote.id),
  ).rejects.toThrow();

  expect(shopify.creates()).toBe(0);
  const saved = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
  expect(saved.status).toBe("DRAFT");
});
