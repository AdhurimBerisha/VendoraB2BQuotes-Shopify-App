import { logger } from "../lib/logger.server";
import * as Sentry from "@sentry/react-router";
import type { Job } from "pg-boss";
import { QUEUES, type QueueName, getBoss } from "./queue.server";
import { runPrivacy, type PrivacyJob } from "./privacy.server";
import type { SendEmailJob } from "../models/notify.server";
import { type SendInvoiceJob, type SyncJob, giveUpInvoice, giveUpSync } from "../models/sync.server";
import type { FlowTriggerJob } from "../models/flow.server";
import { runExpireQuotes } from "./expire-quotes.server";
import { runFlowTrigger } from "./flow-trigger.server";
import { runReconcileAll, runReconcileShop } from "./reconcile.server";
import { type ImportCsvJob, runImportCsv } from "./import-csv.server";
import { type ProcessWebhookJob, runProcessWebhook } from "./process-webhook.server";
import { runSendEmail } from "./send-email.server";
import { runSendInvoiceJob, runSyncDraftOrder } from "./sync-draft-order.server";

declare global {
  // eslint-disable-next-line no-var
  var vendoraWorkersStarted: boolean | undefined;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

// The last attempt failed (M4.2): pg-boss moves the job to "<queue>-dead" (Jobs page → Retry);
// quote jobs also put the quote in Needs attention so nobody waits for it silently.
// ponytail: jobs that time out (expireInSeconds) fail outside this handler and only reach the Jobs page.
const onLastFailure = async (name: QueueName, data: unknown, error: unknown) => {
  const message = errorText(error);
  const shop = (data as { shop?: string }).shop;
  logger.error({ queue: name, shop, error: message }, "job failed for good");
  Sentry.captureException(error, { tags: { queue: name, shop } });
  if (name === "sync-draft-order") await giveUpSync((data as SyncJob).shop, (data as SyncJob).quoteId, message);
  if (name === "send-invoice") await giveUpInvoice(data as SendInvoiceJob, message);
};

// Throwing = pg-boss retries; on the last attempt onLastFailure runs first.
const handle =
  <T>(name: QueueName, run: (job: Job<T>) => Promise<unknown>) =>
  async ([job]: Job<T>[]) => {
    try {
      await run(job);
    } catch (error) {
      if (job.retryCount >= QUEUES[name].retryLimit) {
        await onLastFailure(name, job.data, error).catch((handlerError) =>
          logger.error({ queue: name, error: errorText(handlerError) }, "last-failure handler failed"),
        );
      }
      throw error;
    }
  };

const startWorkers = async () => {
  if (globalThis.vendoraWorkersStarted) return; // dev hot reload imports modules again
  globalThis.vendoraWorkersStarted = true;
  const boss = await getBoss();
  const one = { batchSize: 1 };

  await boss.work<SyncJob>("sync-draft-order", one, handle("sync-draft-order", (job) => runSyncDraftOrder(job.data)));
  await boss.work<SendInvoiceJob>("send-invoice", one, handle("send-invoice", (job) => runSendInvoiceJob(job.data)));
  await boss.work<ProcessWebhookJob>("process-webhook", one, handle("process-webhook", (job) => runProcessWebhook(job.data)));
  await boss.work<ImportCsvJob>("import-csv", one, handle("import-csv", (job) => runImportCsv(job.data)));
  await boss.work("expire-quotes", one, handle("expire-quotes", () => runExpireQuotes()));
  await boss.schedule("expire-quotes", "0 * * * *"); // upsert: safe on every start
  await boss.work("reconcile-all", one, handle("reconcile-all", () => runReconcileAll()));
  await boss.schedule("reconcile-all", "0 3 * * *"); // 03:00 UTC nightly
  await boss.work<{ shop: string }>("reconcile", one, handle("reconcile", (job) => runReconcileShop(job.data.shop)));
  await boss.work<PrivacyJob>("privacy", one, handle("privacy", (job) => runPrivacy(job.data)));
  await boss.work<SendEmailJob>("send-email", one, handle("send-email", (job) => runSendEmail(job.data, { jobId: job.id })));
  await boss.work<FlowTriggerJob>("flow-trigger", one, handle("flow-trigger", (job) => runFlowTrigger(job.data)));
  logger.info("[workers] started");

  // Let running jobs finish before the process exits.
  const stop = async () => {
    await boss.stop({ graceful: true, timeout: 20_000 });
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
};

export { handle, startWorkers };
