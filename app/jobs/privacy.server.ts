import { handlePrivacyWebhook } from "../models/privacy.server";
import { markWebhookProcessed } from "../models/webhook-events.server";

type PrivacyJob = {
  topic: string;
  shop: string;
  payload: Record<string, unknown>;
  webhookId: string;
};

const runPrivacy = async ({ topic, shop, payload, webhookId }: PrivacyJob) => {
  await handlePrivacyWebhook(topic, payload, shop);
  // shop/redact already deleted this shop's WebhookEvent rows.
  if (topic !== "SHOP_REDACT") await markWebhookProcessed(webhookId);
  console.log("privacy job done", { topic, shop, webhookId });
};

export { runPrivacy };
export type { PrivacyJob };
