import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { STALE_MS, convertQuote } from "./quote.server";

const SHOP = `vitest-${randomUUID()}.myshopify.com`;

afterAll(async () => {
  await db.quote.deleteMany({ where: { shop: SHOP } });
  await db.$disconnect();
});

// Fake Shopify that keeps its own draft orders so tag search behaves like the real one.
function fakeShopify({ crashAfterCreate = false } = {}) {
  const drafts: { id: string; tags: string[] }[] = [];
  let creates = 0;
  const graphql = async (
    query: string,
    { variables }: { variables: any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  ) => {
    if (query.includes("draftOrderCreate")) {
      creates++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const id = `gid://shopify/DraftOrder/${drafts.length + 1}`;
      drafts.push({ id, tags: variables.input.tags });
      if (crashAfterCreate) throw new Error("socket hang up");
      return Response.json({
        data: { draftOrderCreate: { draftOrder: { id }, userErrors: [] } },
      });
    }
    if (query.includes("draftOrders")) {
      const tag = /tag:'(.+)'/.exec(variables.query)![1];
      const nodes = drafts.filter((d) => d.tags.includes(tag));
      return Response.json({
        data: { draftOrders: { nodes: nodes.map(({ id }) => ({ id })) } },
      });
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  return {
    admin: { graphql } as unknown as AdminApiContext,
    drafts,
    creates: () => creates,
  };
}

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
