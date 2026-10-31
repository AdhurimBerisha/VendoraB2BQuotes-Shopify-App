import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, expect, test } from "vitest";
import db from "../db.server";
import { testQuote } from "../test/factories";
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
  testQuote(shop, { overrides: { contactCustomerId } });

const seedShop = async (shop: string) => {
  await db.shop.create({ data: { id: shop } });
  await db.session.create({
    data: { id: `offline_${shop}`, shop, state: "", accessToken: "token" },
  });
  await newQuote(shop);
  await db.webhookEvent.create({ data: { id: randomUUID(), shop, topic: "APP_UNINSTALLED" } });
  await db.privacyRequest.create({ data: { shop, topic: "customers/data_request" } });
  await db.auditEvent.create({ data: { shop, actorType: "SYSTEM", action: "quote.created" } });
  await db.staffMember.create({ data: { shop, shopifyUserId: 1n, displayName: "Ana" } });
};

const countFor = async (shop: string) => ({
  shop: await db.shop.count({ where: { id: shop } }),
  session: await db.session.count({ where: { shop } }),
  quote: await db.quote.count({ where: { shop } }),
  webhookEvent: await db.webhookEvent.count({ where: { shop } }),
  privacyRequest: await db.privacyRequest.count({ where: { shop } }),
  auditEvent: await db.auditEvent.count({ where: { shop } }),
  staffMember: await db.staffMember.count({ where: { shop } }),
});

test("shop/redact deletes everything for that shop only", async () => {
  await seedShop(SHOP_A);
  await seedShop(SHOP_B);

  await redactShop(SHOP_A);

  expect(await countFor(SHOP_A)).toEqual({
    shop: 0, session: 0, quote: 0, webhookEvent: 0, privacyRequest: 0, auditEvent: 0, staffMember: 0,
  });
  expect(await countFor(SHOP_B)).toEqual({
    shop: 1, session: 1, quote: 1, webhookEvent: 1, privacyRequest: 1, auditEvent: 1, staffMember: 1,
  });
});

test("every shop-scoped model is covered by redactShop", () => {
  // Fails when a model with a `shop` column is added: add it to redactShop, then here.
  const shopScoped = Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === "shop"))
    .map((model) => model.name)
    .sort();
  expect(shopScoped).toEqual(["AuditEvent", "Import", "PrivacyRequest", "Quote", "Session", "StaffMember", "WebhookEvent"]);
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

test("customers/redact anonymises that customer's history entries", async () => {
  const event = await db.auditEvent.create({
    data: { shop: SHOP_A, actorType: "CUSTOMER", actorId: CUSTOMER_1, action: "quote.viewed" },
  });

  await redactCustomer(SHOP_A, 1);

  expect((await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } })).actorId).toBe(
    "redacted",
  );
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
  expect(requests[0].result).toMatchObject([
    { versions: [{ lines: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 2 }] }] },
    {},
  ]);
});
