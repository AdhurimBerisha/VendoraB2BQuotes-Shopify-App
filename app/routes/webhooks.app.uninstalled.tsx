import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { markUninstalled } from "../models/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // May arrive more than once and after the shop was already cleaned up: markUninstalled is idempotent.
  // M1.6: cancel this shop's queued jobs.
  await markUninstalled(shop);

  return new Response();
};
