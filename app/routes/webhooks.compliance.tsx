import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  forgetWebhook,
  markWebhookProcessed,
  recordWebhookOnce,
} from "../models/webhook-events.server";
import { handlePrivacyWebhook } from "../models/privacy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Throws a 401 Response on a bad HMAC (Shopify requires 401 for compliance webhooks).
  const { topic, shop, payload, webhookId, eventId } = await authenticate.webhook(request);
  console.log("compliance webhook", { topic, shop, webhookId });

  if (await recordWebhookOnce({ webhookId, eventId, shop, topic })) {
    // Inline for now (fast at current data sizes). M1.6 moves this into the `privacy` queue.
    try {
      await handlePrivacyWebhook(topic, payload, shop);
    } catch (error) {
      console.error("compliance webhook failed, Shopify will retry", { topic, shop, webhookId, error });
      await forgetWebhook(webhookId);
      throw error; // non-2xx → Shopify retries the delivery
    }
    // shop/redact already deleted this shop's WebhookEvent rows.
    if (topic !== "SHOP_REDACT") await markWebhookProcessed(webhookId);
  }
  return new Response();
};
