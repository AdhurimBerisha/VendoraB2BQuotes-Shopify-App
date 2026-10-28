import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, expect, test } from "vitest";
import db from "../db.server";
import { collectCustomerData, redactCustomer, redactShop } from "./privacy.server";

const SHOP_A = `vitest-${randomUUID()}.myshopify.com`;
const SHOP_B = `vitest-${randomUUID()}.myshopify.com`;
const CUSTOMER_1 = "gid://shopify/Customer/1";
const CUSTOMER_2 = "gid://shopify/Customer/2";

afterAll(async () => {
  await redactShop(SHOP_A);
  await redactShop(SHOP_B);
  await db.$disconnect();
});

const newQuote = (shop: string, contactCustomerId: string | null = null) =>
  db.quote.create({
    data: {
      shop,
      companyId: "gid://shopify/Company/1",
      companyLocationId: "gid://shopify/CompanyLocation/1",
      companyContactId: "gid://shopify/CompanyContact/1",
      contactCustomerId,
      lines: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
    },
  });

const seedShop = async (shop: string) => {
  await db.shop.create({ data: { id: shop } });
  await db.session.create({
    data: { id: `offline_${shop}`, shop, state: "", accessToken: "token" },
  });
  await newQuote(shop);
  await db.webhookEvent.create({ data: { id: randomUUID(), shop, topic: "APP_UNINSTALLED" } });
  await db.privacyRequest.create({ data: { shop, topic: "customers/data_request" } });
};

const countFor = async (shop: string) => ({
  shop: await db.shop.count({ where: { id: shop } }),
  session: await db.session.count({ where: { shop } }),
  quote: await db.quote.count({ where: { shop } }),
  webhookEvent: await db.webhookEvent.count({ where: { shop } }),
  privacyRequest: await db.privacyRequest.count({ where: { shop } }),
});

test("shop/redact deletes everything for that shop only", async () => {
  await seedShop(SHOP_A);
  await seedShop(SHOP_B);

  await redactShop(SHOP_A);

  expect(await countFor(SHOP_A)).toEqual({
    shop: 0, session: 0, quote: 0, webhookEvent: 0, privacyRequest: 0,
  });
  expect(await countFor(SHOP_B)).toEqual({
    shop: 1, session: 1, quote: 1, webhookEvent: 1, privacyRequest: 1,
  });
});

test("every shop-scoped model is covered by redactShop", () => {
  // Fails when a model with a `shop` column is added: add it to redactShop, then here.
  const shopScoped = Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === "shop"))
    .map((model) => model.name)
    .sort();
  expect(shopScoped).toEqual(["PrivacyRequest", "Quote", "Session", "WebhookEvent"]);
});

test("customers/redact anonymises only that customer's quotes", async () => {
  const first = await newQuote(SHOP_A, CUSTOMER_1);
  const second = await newQuote(SHOP_A, CUSTOMER_1);
  const other = await newQuote(SHOP_A, CUSTOMER_2);

  await redactCustomer(SHOP_A, 1);

  for (const { id } of [first, second]) {
    const quote = await db.quote.findUniqueOrThrow({ where: { id } });
    expect(quote.contactCustomerId).toBe("redacted");
    expect(quote.companyContactId).toBe("redacted");
  }
  const untouched = await db.quote.findUniqueOrThrow({ where: { id: other.id } });
  expect(untouched.contactCustomerId).toBe(CUSTOMER_2);
});

test("customers/data_request collects the customer's quotes", async () => {
  await newQuote(SHOP_B, CUSTOMER_1);
  await newQuote(SHOP_B, CUSTOMER_1);
  await newQuote(SHOP_B, CUSTOMER_2);

  await collectCustomerData(SHOP_B, 1);

  const requests = await db.privacyRequest.findMany({
    where: { shop: SHOP_B, customerGid: CUSTOMER_1 },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].result).toHaveLength(2);
});
