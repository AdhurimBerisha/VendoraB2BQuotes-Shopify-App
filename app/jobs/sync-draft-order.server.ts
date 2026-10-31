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
    console.log("sync-draft-order skipped: shop not installed", { shop: job.shop, quoteId: job.quoteId });
    return;
  }
  await runSync(await deps.getAdmin(job.shop), job); // throws on unclear errors and SyncInFlight
  console.log("sync-draft-order done", { shop: job.shop, quoteId: job.quoteId, op: job.op });
};

const runSendInvoiceJob = async (job: SendInvoiceJob, deps: Deps = defaultDeps) => {
  if (!(await isInstalled(job.shop))) {
    console.log("send-invoice skipped: shop not installed", { shop: job.shop, quoteId: job.quoteId });
    return;
  }
  await runSendInvoice(await deps.getAdmin(job.shop), job);
};

export { runSendInvoiceJob, runSyncDraftOrder };
