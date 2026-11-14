import { logger } from "../lib/logger.server";
import { PgBoss, fromPrisma } from "pg-boss";
import type { Prisma } from "@prisma/client";

// Each milestone adds its queue here.
// sync-draft-order's retryDelay must exceed STALE_MS (120 s) so a retry can re-claim the quote.
const QUEUES = {
  "sync-draft-order": {
    retryLimit: 6,
    retryDelay: 150,
    retryBackoff: true,
    retryDelayMax: 3600,
    expireInSeconds: 120,
  },
  "send-invoice": { retryLimit: 6, retryDelay: 60, retryBackoff: true, retryDelayMax: 3600 },
  "process-webhook": { retryLimit: 8, retryDelay: 30, retryBackoff: true, retryDelayMax: 3600 },
  "import-csv": { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  // Scheduled hourly; a failed run is simply retried by the next one.
  "expire-quotes": { retryLimit: 2, retryDelay: 300, expireInSeconds: 1800 },
  privacy: { retryLimit: 10, retryDelay: 60, retryBackoff: true, retryDelayMax: 21600 },
  // Nightly (M4.3): reconcile-all fans out one reconcile job per shop; a missed night is caught the next.
  "reconcile-all": { retryLimit: 2, retryDelay: 300, expireInSeconds: 600 },
  reconcile: { retryLimit: 3, retryDelay: 600, retryBackoff: true, expireInSeconds: 1800 },
  // A provider outage or a bad token only delays emails (scenario 13).
  "send-email": { retryLimit: 10, retryDelay: 60, retryBackoff: true, retryDelayMax: 21600 },
};
type QueueName = keyof typeof QUEUES;

declare global {
  // eslint-disable-next-line no-var
  var vendoraBoss: Promise<PgBoss> | undefined;
}

const startBoss = async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  // max 3 (default 10): staging's Supabase session pooler allows ~15 connections in total, and Prisma
  // takes up to `connection_limit` (5) from DATABASE_URL. pg ignores that Prisma-only parameter.
  const boss = new PgBoss({ connectionString, max: 3 });
  boss.on("error", (error) => logger.error({ error }, "[pg-boss]"));
  await boss.start();
  for (const [name, config] of Object.entries(QUEUES)) {
    const deadLetter = `${name}-dead`;
    if (!(await boss.getQueue(deadLetter))) await boss.createQueue(deadLetter);
    if (await boss.getQueue(name)) {
      await boss.updateQueue(name, { ...config, deadLetter }); // keep options in sync with code
    } else {
      await boss.createQueue(name, { ...config, deadLetter });
    }
  }
  logger.info({ queues: Object.keys(QUEUES) }, "[pg-boss] started");
  return boss;
};

// One pg-boss per process (dev hot reload re-imports modules). A failed start is retried next call.
const getBoss = (): Promise<PgBoss> => {
  globalThis.vendoraBoss ??= startBoss().catch((error) => {
    globalThis.vendoraBoss = undefined;
    throw error;
  });
  return globalThis.vendoraBoss;
};

// Pass `tx` to send inside a Prisma interactive transaction (atomic with the state change).
// Start the boss (getBoss) before opening that transaction: starting can take longer than its timeout.
const enqueue = async (
  name: QueueName,
  data: object,
  options: { singletonKey?: string; startAfter?: number; tx?: Prisma.TransactionClient } = {},
) => {
  const { tx, ...rest } = options;
  const boss = await getBoss();
  const jobId = await boss.send(name, data, { ...rest, ...(tx ? { db: fromPrisma(tx) } : {}) });
  if (!jobId) throw new Error(`pg-boss did not create a ${name} job (duplicate singletonKey?)`);
  return jobId;
};

export { QUEUES, enqueue, getBoss };
export type { QueueName };
