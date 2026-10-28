import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import db from "../db.server";
import { redactShop } from "../models/privacy.server";
import { webhookRequest } from "../test/webhook";
import { action } from "./webhooks.compliance";

const SHOP = `vitest-${randomUUID()}.myshopify.com`;
const PATH = "/webhooks/compliance";

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

const callAction = async (request: Request) => {
  try {
    return await action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown; // authenticate.webhook throws Responses
    throw thrown;
  }
};

test("bad signature is rejected with 401 and nothing is recorded", async () => {
  const webhookId = randomUUID();
  const response = await callAction(
    webhookRequest(PATH, "shop/redact", SHOP, { shop_domain: SHOP }, { webhookId, badSignature: true }),
  );

  expect(response.status).toBe(401);
  expect(await db.webhookEvent.count({ where: { id: webhookId } })).toBe(0);
});

test("valid shop/redact returns 200 and deletes the shop's data", async () => {
  await db.shop.create({ data: { id: SHOP } });
  await db.quote.create({
    data: {
      shop: SHOP,
      companyId: "gid://shopify/Company/1",
      companyLocationId: "gid://shopify/CompanyLocation/1",
      companyContactId: "gid://shopify/CompanyContact/1",
      lines: [],
    },
  });

  const response = await callAction(webhookRequest(PATH, "shop/redact", SHOP, { shop_domain: SHOP }));

  expect(response.status).toBe(200);
  expect(await db.shop.count({ where: { id: SHOP } })).toBe(0);
  expect(await db.quote.count({ where: { shop: SHOP } })).toBe(0);
});

test("a failed delivery is forgotten so Shopify's retry is handled", async () => {
  const webhookId = randomUUID();
  // Unknown topic → the handler throws, standing in for any failure mid-handling.
  const request = webhookRequest(PATH, "orders/create", SHOP, { customer: { id: 1 } }, { webhookId });

  await expect(callAction(request)).rejects.toThrow("Unhandled privacy topic");
  expect(await db.webhookEvent.count({ where: { id: webhookId } })).toBe(0);
});

test("the same webhook delivered twice is handled once", async () => {
  const webhookId = randomUUID();
  const body = { shop_domain: SHOP, customer: { id: 1 } };

  for (let i = 0; i < 2; i++) {
    const response = await callAction(
      webhookRequest(PATH, "customers/data_request", SHOP, body, { webhookId }),
    );
    expect(response.status).toBe(200);
  }

  expect(await db.privacyRequest.count({ where: { shop: SHOP } })).toBe(1); // handler ran once
  const event = await db.webhookEvent.findUniqueOrThrow({ where: { id: webhookId } });
  expect(event.processedAt).not.toBeNull();
});
