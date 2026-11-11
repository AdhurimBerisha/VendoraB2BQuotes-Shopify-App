import { logger } from "../lib/logger.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { unauthenticated } from "../shopify.server";
import { isInstalled } from "../models/shop.server";
import { type SendInvoiceJob, type SyncJob, runSendInvoice, runSync } from "../models/sync.server";

type Deps = { getAdmin: (shop: string) => Promise<AdminApiContext> };

const defaultDeps: Deps = {
  getAdmin: async (shop) => (await unauthenticated.admin(shop)).admin,
};

// Throwing = pg-boss retries (with backoff), then dead-letters.
// Returning = done. Definite Shopify rejections are stored on the quote (FAILED) and return normally.
const runSyncDraftOrder = async (job: SyncJob, deps: Deps = defaultDeps) => {
  if (!(await isInstalled(job.shop))) {
    logger.info({ shop: job.shop, quoteId: job.quoteId }, "sync-draft-order skipped: shop not installed");
    return;
  }
  await runSync(await deps.getAdmin(job.shop), job); // throws on unclear errors and SyncInFlight
  logger.info({ shop: job.shop, quoteId: job.quoteId, op: job.op }, "sync-draft-order done");
};

const runSendInvoiceJob = async (job: SendInvoiceJob, deps: Deps = defaultDeps) => {
  if (!(await isInstalled(job.shop))) {
    logger.info({ shop: job.shop, quoteId: job.quoteId }, "send-invoice skipped: shop not installed");
    return;
  }
  await runSendInvoice(await deps.getAdmin(job.shop), job);
};

export { runSendInvoiceJob, runSyncDraftOrder };
