import { logger } from "../lib/logger.server";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueue } from "../jobs/queue.server";
import { forgetWebhook, recordWebhookOnce } from "../models/webhook-events.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Throws a 401 Response on a bad HMAC (Shopify requires 401 for compliance webhooks).
  const { topic, shop, payload, webhookId, eventId } = await authenticate.webhook(request);
  logger.info({ topic, shop, webhookId }, "compliance webhook");

  if (await recordWebhookOnce({ webhookId, eventId, shop, topic })) {
    // Answer Shopify fast (5 s timeout); the privacy job does the work and retries on failure.
    try {
      await enqueue("privacy", { topic, shop, payload, webhookId });
    } catch (error) {
      logger.error({ topic, shop, webhookId, error }, "compliance webhook not queued, Shopify will retry");
      await forgetWebhook(webhookId);
      throw error; // non-2xx → Shopify retries the delivery
    }
  }
  return new Response();
};
