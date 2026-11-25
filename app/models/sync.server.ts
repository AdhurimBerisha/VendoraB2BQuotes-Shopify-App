import { logger } from "../lib/logger.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { Prisma } from "@prisma/client";
import db from "../db.server";
import { enqueue, getBoss } from "../jobs/queue.server";
import { ConflictError, NotFoundError, UserError } from "../lib/errors";
import { createI18n } from "../lib/i18n";
import { D } from "../lib/money";
import { quoteLink } from "../lib/signed-token.server";
import { ShopifyDenied, ShopifyThrottled, ShopifyUserErrors } from "../shopify/client.server";
import { getCompanyLocation, getContact } from "../shopify/companies.server";
import * as drafts from "../shopify/draft-orders.server";
import type { Actor, StaffActor, SystemActor } from "./actor";
import { withoutItems } from "./attention";
import { raise } from "./attention.server";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";
import { BLOCKING, type LineProblem } from "./pricing";
import { transition } from "./quote.server";
import { assertB2b, checkB2b } from "./shop.server";

// ponytail: draftOrderCreate has no @idempotent support, so a crashed attempt is only
// reclaimed after STALE_MS and found again by tag. Relies on Shopify's draft-order search
// index catching up within this window; switch to @idempotent if Shopify adds it.
const STALE_MS = 2 * 60_000;

// Shopify's invoiceSentAt vs our invoiceRequestedAt come from different clocks.
const CLOCK_SKEW_MS = 60_000;

// Thrown when another attempt holds the quote; the job throws so pg-boss retries later.
class SyncInFlight extends Error {}

type SyncJob = { shop: string; quoteId: string; op: "upsert" | "delete"; send?: { message: string } };
type SendInvoiceJob = { shop: string; quoteId: string; versionId: string; message: string };
type QuoteWithVersion = Prisma.QuoteGetPayload<{ include: { currentVersion: { include: { lines: true } } } }>;

const system = (shop: string, reason: string): SystemActor => ({ type: "SYSTEM", shop, reason });

// syncStatus → QUEUED, and the job, in one transaction: a QUEUED quote always has a job.
// A SYNCED quote may be synced again (draftOrderUpdate).
const requestSync = async (actor: Actor, quoteId: string, send?: { message: string }) => {
  requirePermission(actor, "quote.send");
  await assertB2b(actor.shop); // M5.3: without B2B every draft order for a company fails
  await getBoss(); // start pg-boss outside the transaction (see enqueue)
  await db.$transaction(async (tx) => {
    const { count } = await tx.quote.updateMany({
      where: {
        id: quoteId,
        shop: actor.shop,
        syncStatus: { in: ["NONE", "FAILED", "SYNCED", "NEEDS_ATTENTION"] },
      },
      data: { syncStatus: "QUEUED", syncError: null },
    });
    if (count !== 1) throw new ConflictError("sync.errors.alreadyRunning");
    const job: SyncJob = { shop: actor.shop, quoteId, op: "upsert", send };
    await enqueue("sync-draft-order", job, { singletonKey: quoteId, tx });
    await audit(tx, actor, quoteId, "sync.requested", { send: !!send });
  });
  logger.info({ shop: actor.shop, quoteId, send: !!send }, "sync queued");
};

// "Send": APPROVED quote → sync the approved version to its draft order → Shopify's invoice email.
const sendQuote = async (actor: StaffActor, quoteId: string, message: string) => {
  requirePermission(actor, "quote.send");
  const quote = await db.quote.findFirst({
    where: { id: quoteId, shop: actor.shop },
    include: { currentVersion: { include: { lines: true } } },
  });
  if (!quote?.currentVersion) throw new NotFoundError();
  if (quote.status !== "APPROVED") throw new ConflictError("quote.errors.notApproved");
  const blocked = quote.currentVersion.lines.some((line) =>
    ((line.problems as LineProblem[] | null) ?? []).some((problem) => BLOCKING.includes(problem)),
  );
  if (blocked) throw new UserError("quote.errors.blockingProblems");
  await requestSync(actor, quoteId, { message: message.slice(0, 5000) });
};

// Runs inside the sync-draft-order job. syncStatus: QUEUED → SYNCING → SYNCED | FAILED | NEEDS_ATTENTION.
// Throw = pg-boss retries; return = done.
const runSync = async (admin: AdminApiContext, job: SyncJob) => {
  const { shop, quoteId } = job;
  // Atomic claim: only one caller moves the quote into SYNCING.
  const now = new Date();
  const claimed = await db.quote.updateMany({
    where: {
      id: quoteId,
      shop,
      OR: [
        { syncStatus: "QUEUED" },
        { syncStatus: "SYNCING", syncClaimedAt: { lt: new Date(now.getTime() - STALE_MS) } },
      ],
    },
    data: { syncStatus: "SYNCING", syncClaimedAt: now },
  });
  const quote = await db.quote.findFirstOrThrow({
    where: { id: quoteId, shop },
    include: { currentVersion: { include: { lines: { orderBy: { position: "asc" } } } } },
  });
  if (claimed.count === 0) {
    if (quote.syncStatus === "SYNCING") {
      throw new SyncInFlight(`Quote ${quoteId} is being synced by another attempt`);
    }
    return; // SYNCED / FAILED / NONE: nothing to do
  }

  try {
    // An upsert queued before a cancel or expiry may claim the quote first: it deletes too.
    if (job.op === "delete" || quote.status === "CANCELLED" || quote.status === "EXPIRED") await doDelete(admin, quote);
    else await doUpsert(admin, quote, job.send);
  } catch (error) {
    if (error instanceof ShopifyThrottled) {
      // Nothing happened in Shopify: free the claim so pg-boss's retry can run at once.
      await db.quote.updateMany({
        where: { id: quote.id, shop, syncStatus: "SYNCING" },
        data: { syncStatus: "QUEUED", syncClaimedAt: null },
      });
      logger.info({ shop, quoteId }, "sync throttled, claim released");
      throw error;
    }
    // Rejected input, or a missing permission (scope or plan): nothing changed and retrying
    // won't help, so a person has to act.
    if (error instanceof ShopifyUserErrors || error instanceof ShopifyDenied) {
      const message = error instanceof ShopifyDenied ? `Missing permission: ${error.message}` : error.message;
      await db.$transaction(async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { syncStatus: "FAILED", syncError: message } });
        await raise(tx, shop, quote.id, { code: "SYNC_FAILED", message });
        await audit(tx, system(shop, "sync-draft-order"), quote.id, "sync.failed", { message });
      });
      // M5.3: denied because the store lost B2B? Then every page says so right away.
      if (error instanceof ShopifyDenied) await checkB2b(admin, shop);
      return;
    }
    // Ambiguous (network, timeout, 5xx): Shopify may have done it. Stay SYNCING
    // so only a stale reclaim retries, and that retry finds the order by tag.
    throw error;
  }
};

const doUpsert = async (admin: AdminApiContext, quote: QuoteWithVersion, send?: { message: string }) => {
  const version = quote.currentVersion;
  if (!version) throw new Error(`Quote ${quote.id} has no current version`);
  const actor = system(quote.shop, "sync-draft-order");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: quote.shop } });
  const location = await getCompanyLocation(admin, quote.companyLocationId);
  if (!location) throw new ShopifyUserErrors(["Company location no longer exists"]);
  // M10.4: the template's type decides whether Shopify needs an issue date.
  const paymentTermsType = quote.paymentTermsTemplateId
    ? ((await drafts.getPaymentTermsTemplates(admin)).find((template) => template.id === quote.paymentTermsTemplateId)
        ?.paymentTermsType ?? null)
    : null;
  const input = drafts.draftOrderInput({ quote, version, location, shop, paymentTermsType });

  let draftOrderId = quote.draftOrderId;
  let adopted = false;
  if (!draftOrderId) {
    const found = await drafts.findDraftOrdersByTag(admin, quote.id);
    const match = found.find(
      (node) =>
        node.purchasingEntity &&
        "company" in node.purchasingEntity &&
        node.purchasingEntity.company.id === quote.companyId &&
        node.purchasingEntity.location.id === quote.companyLocationId,
    );
    if (found.length && !match) {
      // B-1: our tag on a draft order for another company: never adopt or overwrite it.
      const draftOrderIds = found.map((node) => node.id);
      await db.$transaction(async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { syncStatus: "NEEDS_ATTENTION" } });
        await raise(tx, quote.shop, quote.id, { code: "TAG_COLLISION", data: { draftOrderIds } });
        await audit(tx, actor, quote.id, "sync.tag_collision", { draftOrderIds });
      });
      return;
    }
    if (match) {
      draftOrderId = match.id;
      adopted = true;
    }
  }

  // Updating sets the whole content again, so it is safe to repeat.
  const result = draftOrderId
    ? await drafts.updateDraftOrder(admin, draftOrderId, input)
    : await drafts.createDraftOrder(admin, input);

  if (!draftOrderId) measureSearchLag(admin, quote.id);

  // Read back Shopify's subtotal: it applies catalog prices itself, so ours could differ.
  const after = await drafts.getDraftOrder(admin, result.id);
  const shopifySubtotal = after ? D(after.subtotalPriceSet.presentmentMoney.amount) : null;
  const mismatch = shopifySubtotal !== null && shopifySubtotal.minus(version.total).abs().gte(D("0.01"));
  logger.info({
    quoteId: quote.id,
    draftOrderId: result.id,
    adopted,
    ours: version.total.toString(),
    shopify: shopifySubtotal?.toString() ?? null,
  }, "draft order synced");

  await db.$transaction(async (tx) => {
    await tx.quote.update({
      where: { id: quote.id },
      data: {
        syncStatus: mismatch ? "NEEDS_ATTENTION" : "SYNCED",
        // B-18: one error model; a successful sync clears what it resolved.
        syncError: null,
        attention: withoutItems(quote.attention, ["SYNC_FAILED", "TAG_COLLISION", "DRAFT_DELETED", "CHANGED_IN_SHOPIFY", "PRICE_MISMATCH"]) ?? Prisma.DbNull,
        draftOrderId: result.id,
        syncedVersionId: version.id,
        shopifyUpdatedAt: new Date(result.updatedAt),
      },
    });
    await audit(tx, actor, quote.id, adopted ? "sync.adopted" : "sync.succeeded", { draftOrderId: result.id });
    if (mismatch) {
      // Never invoice a price the approver didn't see.
      await raise(tx, quote.shop, quote.id, {
        code: "PRICE_MISMATCH",
        data: { ours: version.total.toString(), shopify: shopifySubtotal.toString() },
      });
      return;
    }
    if (send) {
      const sendJob: SendInvoiceJob = { shop: quote.shop, quoteId: quote.id, versionId: version.id, message: send.message };
      await enqueue("send-invoice", sendJob, { singletonKey: version.id, tx });
    }
  });
};

// B-7: the crash-retry adopts a draft order by tag search, which relies on Shopify's search index
// catching up within STALE_MS. For 1 in 10 creates, log how long that takes (never in tests).
// Alert on "NOT searchable" in the logs. Fire-and-forget: it never delays or fails the sync.
const SEARCH_LAG_SAMPLE = 0.1;
const measureSearchLag = (admin: AdminApiContext, quoteId: string) => {
  if (process.env.NODE_ENV === "test" || Math.random() >= SEARCH_LAG_SAMPLE) return;
  void (async () => {
    const start = Date.now();
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if ((await drafts.findDraftOrdersByTag(admin, quoteId)).length) {
        logger.info({ quoteId, ms: Date.now() - start }, "search_lag: draft order searchable");
        return;
      }
    }
    logger.warn({ quoteId, ms: Date.now() - start }, "search_lag: draft order NOT searchable after 60 s");
  })().catch((error: unknown) => logger.warn({ quoteId, error: String(error) }, "search_lag: measurement failed"));
};

const doDelete = async (admin: AdminApiContext, quote: { id: string; shop: string; draftOrderId: string | null }) => {
  if (quote.draftOrderId) {
    try {
      await drafts.deleteDraftOrder(admin, quote.draftOrderId);
    } catch (error) {
      if (!(error instanceof ShopifyUserErrors)) throw error;
      logger.info({ quoteId: quote.id, message: error.message }, "draft order already gone or completed");
    }
  }
  await db.$transaction(async (tx) => {
    await tx.quote.update({
      where: { id: quote.id },
      data: { syncStatus: "NONE", draftOrderId: null, syncedVersionId: null },
    });
    await audit(tx, system(quote.shop, "sync-draft-order"), quote.id, "sync.deleted", { draftOrderId: quote.draftOrderId });
  });
};

// Sends Shopify's invoice for a synced, approved version. One email per version, also after crashes.
const runSendInvoice = async (admin: AdminApiContext, job: SendInvoiceJob) => {
  const quote = await db.quote.findFirstOrThrow({
    where: { id: job.quoteId, shop: job.shop },
    include: { currentVersion: { select: { versionNumber: true } } },
  });
  if (quote.currentVersionId !== job.versionId || quote.status !== "APPROVED" || !quote.draftOrderId) {
    logger.info({ quoteId: quote.id, status: quote.status }, "send-invoice skipped"); // superseded or already sent
    return;
  }
  const draftOrderId = quote.draftOrderId;

  // Claim: only one attempt per version may ask Shopify to send.
  const claimed = await db.quote.updateMany({
    where: {
      id: quote.id,
      shop: job.shop,
      OR: [{ invoiceSentVersionId: null }, { invoiceSentVersionId: { not: job.versionId } }],
    },
    data: { invoiceSentVersionId: job.versionId, invoiceRequestedAt: new Date() },
  });
  if (claimed.count === 0 && quote.invoiceRequestedAt) {
    // An earlier attempt claimed it, then failed unclearly: did Shopify send it?
    const draft = await drafts.getDraftOrder(admin, draftOrderId);
    const sentAt = draft?.invoiceSentAt ? new Date(draft.invoiceSentAt) : null;
    if (sentAt && sentAt.getTime() >= quote.invoiceRequestedAt.getTime() - CLOCK_SKEW_MS) {
      return markSent(quote.id, job, draft?.invoiceUrl ?? null);
    }
    // Not sent: send now.
  }

  const failed = async (message: string) => {
    await db.$transaction(async (tx) => {
      await tx.quote.update({ where: { id: quote.id }, data: { invoiceSentVersionId: null } });
      await raise(tx, job.shop, quote.id, { code: "INVOICE_FAILED", message });
      await audit(tx, system(job.shop, "send-invoice"), quote.id, "invoice.failed", { message });
    });
  };

  const contact = await getContact(admin, quote.companyContactId);
  const to = contact?.customer?.defaultEmailAddress?.emailAddress;
  if (!to) return failed("The contact has no email address");

  const shop = await db.shop.findUniqueOrThrow({ where: { id: job.shop } });
  const link = quoteLink(process.env.SHOPIFY_APP_URL ?? "", {
    shop: job.shop,
    quoteId: quote.id,
    version: quote.currentVersion?.versionNumber ?? 1,
    expiresAt: quote.expiresAt,
  });
  // ponytail: English only until a second language exists; then use the contact's customer locale.
  const { t } = createI18n("en");
  let invoiceUrl: string | null;
  try {
    invoiceUrl = await drafts.sendInvoice(admin, draftOrderId, {
      to,
      subject: `Quote ${shop.quotePrefix}${quote.number}`,
      customMessage: `${job.message}

${t("email.viewQuote")}: ${link}`.trim(),
    });
  } catch (error) {
    if (error instanceof ShopifyUserErrors) return failed(error.message);
    if (error instanceof ShopifyDenied) return failed(`Missing permission: ${error.message}`);
    throw error; // unclear or throttled → retry → the claim branch checks invoiceSentAt before resending
  }
  await markSent(quote.id, job, invoiceUrl);
};

const markSent = async (quoteId: string, job: SendInvoiceJob, invoiceUrl: string | null) => {
  await db.$transaction(async (tx) => {
    const { attention } = await tx.quote.findUniqueOrThrow({ where: { id: quoteId }, select: { attention: true } });
    await transition(tx, job.shop, quoteId, "send", "SENT", {
      attention: withoutItems(attention, ["INVOICE_FAILED"]) ?? Prisma.DbNull,
      invoiceUrl,
    });
    await audit(tx, system(job.shop, "send-invoice"), quoteId, "quote.sent", { versionId: job.versionId });
  });
  logger.info({ shop: job.shop, quoteId, versionId: job.versionId }, "quote sent");
};

// The last retry of a sync job failed (M4.2): stop waiting and ask a person (Retry action).
const giveUpSync = async (shop: string, quoteId: string, error: string) => {
  await db.$transaction(async (tx) => {
    const { count } = await tx.quote.updateMany({
      where: { id: quoteId, shop, syncStatus: { in: ["QUEUED", "SYNCING"] } },
      data: { syncStatus: "NEEDS_ATTENTION", syncClaimedAt: null, syncError: error },
    });
    if (count !== 1) return; // finished some other way meanwhile
    await raise(tx, shop, quoteId, { code: "RETRIES_EXHAUSTED", message: error });
    await audit(tx, system(shop, "sync-draft-order"), quoteId, "sync.gave_up", { error });
  });
};

// The last retry of a send-invoice job failed: the quote stays APPROVED; "Retry send" sends again.
const giveUpInvoice = async (job: SendInvoiceJob, error: string) => {
  await db.$transaction(async (tx) => {
    const quote = await tx.quote.findFirst({ where: { id: job.quoteId, shop: job.shop }, select: { status: true } });
    if (quote?.status !== "APPROVED") return; // sent or closed meanwhile
    await raise(tx, job.shop, job.quoteId, { code: "INVOICE_FAILED", message: error });
    await audit(tx, system(job.shop, "send-invoice"), job.quoteId, "invoice.failed", { message: error });
  });
};

export { STALE_MS, SyncInFlight, giveUpInvoice, giveUpSync, requestSync, runSendInvoice, runSync, sendQuote };
export type { SendInvoiceJob, SyncJob };
