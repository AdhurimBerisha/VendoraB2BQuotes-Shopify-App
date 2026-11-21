import { logger } from "../lib/logger.server";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { updateShopFromWebhook } from "../models/shop.server";

// M10.1: keeps Shop.name / currencyCode / timezone current after install (they were only read on install).
// Idempotent, so no dedupe: a repeated delivery writes the same values.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  logger.info({ topic, shop }, "webhook received");
  await updateShopFromWebhook(shop, payload);
  return new Response();
};
