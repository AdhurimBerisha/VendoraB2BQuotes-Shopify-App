import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import db from "../db.server";
import { enqueue } from "../jobs/queue.server";
import { redactShop } from "../models/privacy.server";
import { webhookRequest } from "../test/webhook";
import { action } from "./webhooks.draft-orders";

vi.mock("../jobs/queue.server", () => ({ enqueue: vi.fn(async () => "job-id") }));
const enqueueMock = vi.mocked(enqueue);

const SHOP = `vitest-${randomUUID()}.myshopify.com`;
const PATH = "/webhooks/draft-orders";

beforeEach(() => enqueueMock.mockClear());

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

const callAction = (request: Request) =>
  action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);

test("bad signature is rejected with 401, nothing recorded or queued (M4.5)", async () => {
  const webhookId = randomUUID();
  const body = { id: 1, status: "open", order_id: null, updated_at: new Date().toISOString(), line_items: [] };
  const response = await callAction(
    webhookRequest(PATH, "draft_orders/update", SHOP, body, { webhookId, badSignature: true }),
  ).catch((thrown: unknown) => {
    if (thrown instanceof Response) return thrown; // authenticate.webhook throws Responses
    throw thrown;
  });

  expect(response.status).toBe(401);
  expect(await db.webhookEvent.count({ where: { id: webhookId } })).toBe(0);
  expect(enqueueMock).not.toHaveBeenCalled();
});

test("the same delivery twice queues one process-webhook job", async () => {
  const webhookId = randomUUID();
  const body = { id: 1, status: "open", order_id: null, updated_at: new Date().toISOString(), line_items: [] };

  for (let i = 0; i < 2; i++) {
    const response = await callAction(webhookRequest(PATH, "draft_orders/update", SHOP, body, { webhookId }));
    expect(response.status).toBe(200);
  }

  expect(enqueueMock).toHaveBeenCalledTimes(1);
  expect(enqueueMock).toHaveBeenCalledWith("process-webhook", {
    webhookId,
    topic: "DRAFT_ORDERS_UPDATE",
    shop: SHOP,
    payload: body,
  });
});
