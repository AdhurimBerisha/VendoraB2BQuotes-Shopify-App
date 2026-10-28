import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import db from "../db.server";
import { enqueue } from "../jobs/queue.server";
import { runPrivacy } from "../jobs/privacy.server";
import { redactShop } from "../models/privacy.server";
import { webhookRequest } from "../test/webhook";
import { action } from "./webhooks.compliance";

vi.mock("../jobs/queue.server", () => ({ enqueue: vi.fn(async () => "job-id") }));
const enqueueMock = vi.mocked(enqueue);

const SHOP = `vitest-${randomUUID()}.myshopify.com`;
const PATH = "/webhooks/compliance";

beforeEach(() => enqueueMock.mockClear());

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

test("bad signature is rejected with 401, nothing recorded or queued", async () => {
  const webhookId = randomUUID();
  const response = await callAction(
    webhookRequest(PATH, "shop/redact", SHOP, { shop_domain: SHOP }, { webhookId, badSignature: true }),
  );

  expect(response.status).toBe(401);
  expect(await db.webhookEvent.count({ where: { id: webhookId } })).toBe(0);
  expect(enqueueMock).not.toHaveBeenCalled();
});

test("valid webhook returns 200 and queues a privacy job", async () => {
  const webhookId = randomUUID();
  const response = await callAction(
    webhookRequest(PATH, "shop/redact", SHOP, { shop_domain: SHOP }, { webhookId }),
  );

  expect(response.status).toBe(200);
  expect(enqueueMock).toHaveBeenCalledWith("privacy", {
    topic: "SHOP_REDACT",
    shop: SHOP,
    payload: { shop_domain: SHOP },
    webhookId,
  });
});

test("a delivery that can't be queued is forgotten so Shopify's retry is handled", async () => {
  enqueueMock.mockRejectedValueOnce(new Error("database down"));
  const webhookId = randomUUID();

  await expect(
    callAction(webhookRequest(PATH, "customers/redact", SHOP, { customer: { id: 1 } }, { webhookId })),
  ).rejects.toThrow("database down");
  expect(await db.webhookEvent.count({ where: { id: webhookId } })).toBe(0);
});

test("the same webhook delivered twice is queued once", async () => {
  const webhookId = randomUUID();
  const body = { shop_domain: SHOP, customer: { id: 1 } };

  for (let i = 0; i < 2; i++) {
    const response = await callAction(
      webhookRequest(PATH, "customers/data_request", SHOP, body, { webhookId }),
    );
    expect(response.status).toBe(200);
  }

  expect(enqueueMock).toHaveBeenCalledTimes(1);
});

test("privacy job handles the request and marks the delivery processed", async () => {
  const webhookId = randomUUID();
  await db.webhookEvent.create({ data: { id: webhookId, shop: SHOP, topic: "CUSTOMERS_DATA_REQUEST" } });

  await runPrivacy({
    topic: "CUSTOMERS_DATA_REQUEST",
    shop: SHOP,
    payload: { customer: { id: 42 } },
    webhookId,
  });

  expect(
    await db.privacyRequest.count({ where: { shop: SHOP, customerGid: "gid://shopify/Customer/42" } }),
  ).toBe(1);
  const event = await db.webhookEvent.findUniqueOrThrow({ where: { id: webhookId } });
  expect(event.processedAt).not.toBeNull();
});
