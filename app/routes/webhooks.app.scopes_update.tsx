import { logger } from "../lib/logger.server";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// The merchant approved (or Shopify removed) permissions. Every stored session of the shop gets
// the new list, staff sessions too: the "missing permissions" banner (M5.3, app.tsx) and the
// setup wizard's check read it from the session of whoever is looking.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  logger.info({ topic, shop }, "webhook received");

  const current = payload.current as string[];
  await db.session.updateMany({ where: { shop }, data: { scope: current.toString() } });
  return new Response();
};
