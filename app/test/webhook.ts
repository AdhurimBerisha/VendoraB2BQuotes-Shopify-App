import { createHmac, randomUUID } from "node:crypto";

type WebhookOptions = { webhookId?: string; badSignature?: boolean };

// Builds a webhook request signed like Shopify does (base64 HMAC-SHA256 of the raw body).
const webhookRequest = (
  path: string,
  topic: string, // "shop/redact"
  shop: string,
  body: object,
  { webhookId = randomUUID(), badSignature = false }: WebhookOptions = {},
) => {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("SHOPIFY_API_SECRET missing: check .env.test");
  const raw = JSON.stringify(body);
  const hmac = createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  return new Request(`https://vendora.test${path}`, {
    method: "POST",
    body: raw,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": badSignature ? "invalid" : hmac,
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Webhook-Id": webhookId,
      "X-Shopify-Event-Id": randomUUID(),
      "X-Shopify-Triggered-At": new Date().toISOString(),
    },
  });
};

export { webhookRequest };
