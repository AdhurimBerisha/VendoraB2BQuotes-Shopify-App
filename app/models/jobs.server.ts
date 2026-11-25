import { logger } from "../lib/logger.server";
import { Prisma } from "@prisma/client";
import db from "../db.server";
import { NotFoundError, UserError } from "../lib/errors";
import { QUEUES, type QueueName, getBoss } from "../jobs/queue.server";
import type { StaffActor } from "./actor";
import { withoutItems } from "./attention";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";

// Jobs page (M4.2): background work of this shop that failed every retry. pg-boss moved it to
// "<queue>-dead"; Retry moves it back (redrive). Every query filters by the shop's id in the
// job data: one shop never sees another's jobs. Jobs for all shops at once aren't listed.
const ALL_SHOPS = ["expire-quotes", "follow-ups", "reconcile-all"] as const;
type ShopQueue = Exclude<QueueName, (typeof ALL_SHOPS)[number]>;
const SHOP_QUEUES = (Object.keys(QUEUES) as QueueName[]).filter(
  (name): name is ShopQueue => !(ALL_SHOPS as readonly string[]).includes(name),
);
const MAX_ROWS = 50;

type FailedJob = {
  id: string;
  queue: QueueName;
  quoteId: string | null;
  error: string;
  attempts: number;
  failedAt: string;
};

const errorOf = (output: unknown) => {
  const value = (output as { message?: unknown; value?: { message?: unknown } } | null) ?? {};
  const message = value.message ?? value.value?.message;
  return typeof message === "string" ? message.slice(0, 300) : "";
};

const listFailedJobs = async (actor: StaffActor): Promise<FailedJob[]> => {
  requirePermission(actor, "jobs.retry");
  const boss = await getBoss();
  const perQueue = await Promise.all(
    SHOP_QUEUES.map(async (queue) => {
      const jobs = await boss.findJobs<{ quoteId?: string }>(`${queue}-dead`, { data: { shop: actor.shop }, queued: true });
      return jobs.map((job) => ({
        id: job.id,
        queue,
        quoteId: typeof job.data.quoteId === "string" ? job.data.quoteId : null,
        error: errorOf(job.sourceOutput),
        attempts: (job.sourceRetryCount ?? 0) + 1,
        failedAt: job.createdOn.toISOString(), // when it reached the dead letter queue
      }));
    }),
  );
  return perQueue
    .flat()
    .sort((a, b) => b.failedAt.localeCompare(a.failedAt))
    .slice(0, MAX_ROWS);
};

const retryFailedJob = async (actor: StaffActor, queue: string, jobId: string) => {
  requirePermission(actor, "jobs.retry");
  if (!SHOP_QUEUES.includes(queue as ShopQueue)) throw new UserError("errors.invalidInput");
  const boss = await getBoss();
  const dead = `${queue}-dead`;
  const [job] = await boss.findJobs<{ quoteId?: string }>(dead, { id: jobId, data: { shop: actor.shop }, queued: true });
  if (!job) throw new NotFoundError();
  const quoteId = typeof job.data.quoteId === "string" ? job.data.quoteId : null;

  // A sync gave up with the quote in Needs attention; it must be claimable again.
  if (queue === "sync-draft-order" && quoteId) {
    const quote = await db.quote.findFirst({ where: { id: quoteId, shop: actor.shop }, select: { attention: true } });
    await db.quote.updateMany({
      where: { id: quoteId, shop: actor.shop, syncStatus: { in: ["FAILED", "NEEDS_ATTENTION"] } },
      data: { syncStatus: "QUEUED", syncError: null, attention: withoutItems(quote?.attention, ["RETRIES_EXHAUSTED"]) ?? Prisma.DbNull },
    });
  }
  const moved = await boss.redrive(dead, { ids: [jobId], data: { shop: actor.shop }, destination: queue });
  if (moved === 0) throw new NotFoundError();
  await db.$transaction((tx) => audit(tx, actor, quoteId, "job.retried", { queue, jobId }));
  logger.info({ shop: actor.shop, queue, jobId }, "dead job retried");
};

export { listFailedJobs, retryFailedJob };
export type { FailedJob };
