import { logger } from "../lib/logger.server";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueue } from "../jobs/queue.server";
import { forgetWebhook, recordWebhookOnce } from "../models/webhook-events.server";

// products/update and products/delete. Same shape as webhooks.draft-orders.tsx.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, webhookId, eventId } = await authenticate.webhook(request);

  if (await recordWebhookOnce({ webhookId, eventId, shop, topic })) {
    // Answer Shopify fast (5 s timeout); the process-webhook job does the work.
    try {
      await enqueue("process-webhook", { webhookId, topic, shop, payload });
    } catch (error) {
      logger.error({ topic, shop, webhookId, error }, "webhook not queued, Shopify will retry");
      await forgetWebhook(webhookId);
      throw error; // non-2xx → Shopify retries the delivery
    }
  }
  return new Response();
};
