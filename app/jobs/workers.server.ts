import { getBoss } from "./queue.server";
import { runPrivacy, type PrivacyJob } from "./privacy.server";
import type { SendInvoiceJob, SyncJob } from "../models/sync.server";
import { type ProcessWebhookJob, runProcessWebhook } from "./process-webhook.server";
import { runSendInvoiceJob, runSyncDraftOrder } from "./sync-draft-order.server";

declare global {
  // eslint-disable-next-line no-var
  var vendoraWorkersStarted: boolean | undefined;
}

const startWorkers = async () => {
  if (globalThis.vendoraWorkersStarted) return; // dev hot reload imports modules again
  globalThis.vendoraWorkersStarted = true;
  const boss = await getBoss();

  await boss.work<SyncJob>("sync-draft-order", { batchSize: 1 }, async ([job]) =>
    runSyncDraftOrder(job.data),
  );
  await boss.work<SendInvoiceJob>("send-invoice", { batchSize: 1 }, async ([job]) =>
    runSendInvoiceJob(job.data),
  );
  await boss.work<ProcessWebhookJob>("process-webhook", { batchSize: 1 }, async ([job]) =>
    runProcessWebhook(job.data),
  );
  await boss.work<PrivacyJob>("privacy", { batchSize: 1 }, async ([job]) => runPrivacy(job.data));
  console.log("[workers] started");

  // Let running jobs finish before the process exits.
  const stop = async () => {
    await boss.stop({ graceful: true, timeout: 20_000 });
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
};

export { startWorkers };
