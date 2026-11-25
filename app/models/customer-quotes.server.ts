import { logger } from "../lib/logger.server";
import db from "../db.server";
import { ConflictError, NotFoundError, UserError } from "../lib/errors";
import { quoteLink } from "../lib/signed-token.server";
import { enqueue, getBoss } from "../jobs/queue.server";
import { companyIdsForCustomer } from "../shopify/companies.server";
import { authenticate, unauthenticated } from "../shopify.server";
import type { CustomerActor } from "./actor";
import { raise } from "./attention.server";
import { audit } from "./audit.server";
import { notify } from "./notify.server";
import { recordView } from "./public-quote.server";
import { savePoNumber, transition } from "./quote.server";

// Buyers in the customer account "Quotes" page (M3.4). Drafts and internal states stay hidden.
const VISIBLE = ["SENT", "ORDERED", "DECLINED", "EXPIRED"];
const DAY_MS = 86_400_000;

type CustomerQuote = {
  id: string;
  label: string;
  status: string;
  total: string; // decimal string; the extension formats it in the buyer's locale
  currencyCode: string;
  expiresAt: string | null;
  timeZone: string; // M10.1: the shop's zone, so the buyer sees the shop's expiry date, not their own day
  invoiceUrl: string | null;
  pdfUrl: string | null;
  poNumber: string | null; // M9.3
};
type CustomerAction = "decline" | "changes";

// The token's dest is the shop domain, with or without https://.
const shopFromDest = (dest: string) => (dest.startsWith("http") ? new URL(dest).hostname : dest);

// The logged-in buyer behind a customer account extension request, and their companies.
// Throws a 401 Response without a valid session token or a logged-in customer (no `sub`).
// OPTIONS preflight requests are answered by the library (thrown Response).
const authenticateCustomer = async (request: Request) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  const shop = shopFromDest(sessionToken.dest);
  const customerId = sessionToken.sub;
  if (!customerId) throw cors(new Response(null, { status: 401 }));
  const { admin } = await unauthenticated.admin(shop);
  const companyIds = await companyIdsForCustomer(admin, customerId);
  const actor: CustomerActor = { type: "CUSTOMER", shop, customerId };
  return { actor, companyIds, cors };
};

// No internal notes, attention items or rep details: only what the buyer already received.
const listCustomerQuotes = async (shop: string, companyIds: string[]): Promise<CustomerQuote[]> => {
  if (companyIds.length === 0) return [];
  const [shopRow, quotes] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shop } }),
    db.quote.findMany({
      where: { shop, companyId: { in: companyIds }, status: { in: VISIBLE } },
      include: { currentVersion: { select: { total: true, versionNumber: true } } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
  ]);
  // M10.3: opening this page shows the buyer every quote waiting for them, so it counts as a view.
  for (const quote of quotes) {
    if (quote.status === "SENT") await recordView(quote, quote.currentVersion?.versionNumber ?? 1, "account");
  }
  const now = Date.now();
  return quotes.map((quote) => {
    // The signed link stops working 7 days after expiry (M3.2); don't offer a dead link.
    const linkAlive = !quote.expiresAt || quote.expiresAt.getTime() + 7 * DAY_MS > now;
    return {
      id: quote.id,
      label: `${shopRow.quotePrefix}${quote.number}`,
      status: quote.status,
      total: quote.currentVersion?.total.toString() ?? "0",
      currencyCode: quote.currencyCode,
      expiresAt: quote.expiresAt?.toISOString() ?? null,
      timeZone: shopRow.timezone,
      invoiceUrl: quote.status === "SENT" ? quote.invoiceUrl : null,
      poNumber: quote.poNumber,
      pdfUrl: linkAlive
        ? `${quoteLink(process.env.SHOPIFY_APP_URL ?? "", {
            shop,
            quoteId: quote.id,
            version: quote.currentVersion?.versionNumber ?? 1,
            expiresAt: quote.expiresAt,
          })}/pdf`
        : null,
    };
  });
};

// Decline (→ DECLINED, draft order deleted) or request changes (stays SENT, needs attention).
// companyIds come from Shopify for the logged-in buyer: a quote of another company is a 404.
const customerAction = async (
  actor: CustomerActor,
  companyIds: string[],
  quoteId: string,
  action: CustomerAction,
  message: string,
) => {
  const text = message.trim();
  if (!text || text.length > 1000) throw new UserError("errors.invalidInput");
  const { shop } = actor;
  const quote = await db.quote.findFirst({ where: { id: quoteId, shop, companyId: { in: companyIds } } });
  if (!quote) throw new NotFoundError();
  if (quote.status !== "SENT") throw new ConflictError("quote.errors.invalidTransition", { action });

  await getBoss(); // start pg-boss outside the transaction (see enqueue)
  await db.$transaction(async (tx) => {
    if (action === "decline") {
      await transition(tx, shop, quote.id, "decline", "DECLINED");
      await audit(tx, actor, quote.id, "quote.declined", { message: text });
      if (quote.draftOrderId) {
        // QUEUED so runSync can claim it.
        await tx.quote.update({ where: { id: quote.id }, data: { syncStatus: "QUEUED", syncError: null } });
        await enqueue("sync-draft-order", { shop, quoteId: quote.id, op: "delete" }, { singletonKey: `${quote.id}:delete`, tx });
      }
    } else {
      await raise(tx, shop, quote.id, { code: "CHANGES_REQUESTED", message: text });
      await audit(tx, actor, quote.id, "quote.changes_requested", { message: text });
    }
    await notify(
      tx,
      shop,
      action === "decline" ? "quoteDeclined" : "changesRequested",
      { kind: "user", userId: quote.assignedToUserId },
      { quoteId: quote.id, comment: text },
    );
  });
  logger.info({ shop, quoteId: quote.id, action }, "customer quote action");
};

// M9.3: the buyer adds their PO number to a sent quote before paying.
const customerSetPoNumber = async (actor: CustomerActor, companyIds: string[], quoteId: string, poNumber: string) => {
  const quote = await db.quote.findFirst({ where: { id: quoteId, shop: actor.shop, companyId: { in: companyIds } } });
  if (!quote) throw new NotFoundError();
  if (quote.status !== "SENT") throw new ConflictError("quote.errors.poNumberClosed");
  await savePoNumber(async () => (await unauthenticated.admin(actor.shop)).admin, actor, quote, poNumber);
};

export { authenticateCustomer, customerAction, customerSetPoNumber, listCustomerQuotes, shopFromDest };
export type { CustomerAction, CustomerQuote };
