import { processWebhook } from "../models/webhooks.server";
import { markWebhookProcessed } from "../models/webhook-events.server";

type ProcessWebhookJob = { webhookId: string; topic: string; shop: string; payload: unknown };

// Throwing = pg-boss retries; the error is kept on the WebhookEvent row meanwhile.
const runProcessWebhook = async ({ webhookId, topic, shop, payload }: ProcessWebhookJob) => {
  try {
    await processWebhook(topic, shop, payload);
  } catch (error) {
    await markWebhookProcessed(webhookId, String(error));
    throw error;
  }
  await markWebhookProcessed(webhookId);
};

export { runProcessWebhook };
export type { ProcessWebhookJob };
