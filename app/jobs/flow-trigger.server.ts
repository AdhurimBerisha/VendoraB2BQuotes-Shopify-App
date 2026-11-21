import { logger } from "../lib/logger.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import type { FlowTriggerJob } from "../models/flow.server";
import { unauthenticated } from "../shopify.server";
import { ShopifyUserErrors } from "../shopify/client.server";
import { sendFlowTrigger } from "../shopify/flow.server";

type GetAdmin = (shop: string) => Promise<AdminApiContext>;
const defaultGetAdmin: GetAdmin = async (shop) => (await unauthenticated.admin(shop)).admin;

// Reference fields are sent as numbers: 1234567 from gid://shopify/Company/1234567.
const numericId = (gid: string) => Number(gid.split("/").pop());

// What every trigger sends (keep in step with the fields in extensions/vendora-quote-*/shopify.extension.toml).
// The quote as it is when the job runs, which is at most seconds after the event.
const flowPayload = (
  quote: {
    id: string;
    number: number;
    companyId: string;
    companyContactId: string;
    currencyCode: string;
    poNumber: string | null;
    orderId: string | null;
    currentVersion: { total: { toNumber: () => number } } | null;
  },
  shop: { id: string; quotePrefix: string },
  handle: string,
) => ({
  company_id: numericId(quote.companyId),
  company_contact_id: numericId(quote.companyContactId),
  "Quote number": `${shop.quotePrefix}${quote.number}`,
  // Shopify's admin URL for an embedded app path; it opens the quote in whichever Vendora app this is.
  "Quote URL": `https://${shop.id}/admin/apps/${process.env.SHOPIFY_API_KEY ?? ""}/app/quotes/${quote.id}`,
  Total: quote.currentVersion?.total.toNumber() ?? 0,
  Currency: quote.currencyCode,
  "PO number": quote.poNumber ?? "",
  ...(handle === "vendora-quote-ordered" && quote.orderId ? { order_id: numericId(quote.orderId) } : {}),
});

// Sends one trigger. Shopify's userErrors (e.g. the trigger isn't deployed to this app yet) won't
// change on retry, so they're logged, not retried; network errors and throttling retry.
const runFlowTrigger = async (job: FlowTriggerJob, getAdmin: GetAdmin = defaultGetAdmin) => {
  const [quote, shop] = await Promise.all([
    db.quote.findFirst({
      where: { id: job.quoteId, shop: job.shop },
      include: { currentVersion: { select: { total: true } } },
    }),
    db.shop.findUnique({ where: { id: job.shop } }),
  ]);
  if (!quote || !shop || shop.uninstalledAt) {
    logger.info({ shop: job.shop, quoteId: job.quoteId, handle: job.handle }, "flow trigger skipped: quote or shop gone");
    return;
  }
  if (job.handle === "vendora-quote-ordered" && !quote.orderId) {
    logger.warn({ shop: job.shop, quoteId: quote.id }, "flow trigger skipped: ordered quote without an order id");
    return;
  }
  try {
    await sendFlowTrigger(await getAdmin(job.shop), job.handle, flowPayload(quote, shop, job.handle));
    logger.info({ shop: job.shop, quoteId: quote.id, handle: job.handle }, "flow trigger sent");
  } catch (error) {
    if (!(error instanceof ShopifyUserErrors)) throw error;
    logger.warn({ shop: job.shop, quoteId: quote.id, handle: job.handle, error: error.message }, "flow trigger rejected by Shopify");
  }
};

export { flowPayload, runFlowTrigger };
