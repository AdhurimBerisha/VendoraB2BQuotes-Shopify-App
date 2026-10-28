import db from "../db.server";

type WebhookDelivery = {
  webhookId: string;
  eventId?: string;
  shop: string;
  topic: string;
};

// Returns true the first time a delivery id is seen, false for duplicates.
const recordWebhookOnce = async (delivery: WebhookDelivery) => {
  const { count } = await db.webhookEvent.createMany({
    data: [
      {
        id: delivery.webhookId,
        eventId: delivery.eventId,
        shop: delivery.shop,
        topic: delivery.topic,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
};

const markWebhookProcessed = (webhookId: string, error?: string) =>
  db.webhookEvent.updateMany({
    where: { id: webhookId },
    data: { processedAt: new Date(), error },
  });

// Undo recordWebhookOnce after a failure so Shopify's retry (same webhook id) is handled.
const forgetWebhook = (webhookId: string) =>
  db.webhookEvent.deleteMany({ where: { id: webhookId } });

export { forgetWebhook, markWebhookProcessed, recordWebhookOnce };
