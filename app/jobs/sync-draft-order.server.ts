import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { unauthenticated } from "../shopify.server";
import { isInstalled } from "../models/shop.server";
import { convertQuote } from "../models/quote.server";

type SyncDraftOrderJob = { shop: string; quoteId: string };
type Deps = { getAdmin: (shop: string) => Promise<AdminApiContext> };

const defaultDeps: Deps = {
  getAdmin: async (shop) => (await unauthenticated.admin(shop)).admin,
};

// Throwing = pg-boss retries (with backoff), then dead-letters.
// Returning = done. Definite Shopify rejections are stored on the quote (FAILED) and return normally.
const runSyncDraftOrder = async (
  { shop, quoteId }: SyncDraftOrderJob,
  deps: Deps = defaultDeps,
) => {
  if (!(await isInstalled(shop))) {
    console.log("sync-draft-order skipped: shop not installed", { shop, quoteId });
    return;
  }
  const admin = await deps.getAdmin(shop);
  const quote = await convertQuote(admin, shop, quoteId); // throws on unclear errors and ConversionInFlight
  console.log("sync-draft-order done", { shop, quoteId, status: quote.status });
};

export { runSyncDraftOrder };
export type { SyncDraftOrderJob };
