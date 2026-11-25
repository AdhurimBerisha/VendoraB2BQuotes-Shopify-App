import { logger } from "../lib/logger.server";
import db from "../db.server";
import { clientIp, rateLimit } from "../lib/rate-limit.server";
import { verifyQuoteToken } from "../lib/signed-token.server";
import { unauthenticated } from "../shopify.server";
import type { CustomerActor } from "./actor";
import { audit } from "./audit.server";
import { notify } from "./notify.server";
import { savePoNumber } from "./quote.server";

// Headers for every /q/* response: not indexed, the token never leaks in a Referer to another site,
// not cached, no MIME sniffing. same-origin, not no-referrer: with no-referrer browsers send
// `Origin: null` on the accept form's POST and React Router's CSRF check rejects it (M9.3).
const PUBLIC_HEADERS = {
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Cache-Control": "private, no-store",
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Bad, expired and unknown links all get the same 404, so nothing leaks.
const notFound = () => new Response("Not found", { status: 404, headers: PUBLIC_HEADERS });

// The quote behind a signed link (M3.2). Throws 429 or 404 Responses.
// The shop comes from the signed token, never from the URL.
const findPublicQuote = async (request: Request, token: string) => {
  if (!rateLimit(`q:${clientIp(request)}`)) {
    throw new Response("Too many requests", { status: 429, headers: PUBLIC_HEADERS });
  }
  const payload = verifyQuoteToken(token);
  if (!payload) throw notFound();

  const [quote, shop] = await Promise.all([
    db.quote.findFirst({
      where: { id: payload.quoteId, shop: payload.shop },
      include: {
        versions: {
          where: { versionNumber: payload.version },
          include: { lines: { orderBy: { position: "asc" } } },
        },
      },
    }),
    db.shop.findUnique({ where: { id: payload.shop } }),
  ]);
  const version = quote?.versions[0];
  if (!quote || !version || !shop || shop.uninstalledAt) {
    logger.info({ shop: payload.shop, quoteId: payload.quoteId, version: payload.version }, "public quote not found");
    throw notFound();
  }
  // A newer version exists: the old link shows no data.
  const superseded = quote.currentVersionId !== version.id;
  return { quote, version, shop, superseded };
};

type ViewSource = "page" | "pdf" | "account";

// M10.3: at most one "viewed" event per quote per hour (so "Viewed 4×" means something), and the
// rep's email at most once a day. Whoever opens it acts for the quote's contact.
const recordView = async (
  quote: { id: string; shop: string; contactCustomerId: string | null; assignedToUserId: bigint | null },
  version: number,
  source: ViewSource,
) => {
  const now = Date.now();
  const last = await db.auditEvent.findFirst({
    where: { shop: quote.shop, quoteId: quote.id, action: "quote.viewed", createdAt: { gte: new Date(now - DAY_MS) } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (last && now - last.createdAt.getTime() < HOUR_MS) return;
  const actor = { type: "CUSTOMER" as const, shop: quote.shop, customerId: quote.contactCustomerId ?? "unknown" };
  await audit(db, actor, quote.id, "quote.viewed", { version, source });
  if (!last) await notify(db, quote.shop, "quoteViewed", { kind: "user", userId: quote.assignedToUserId }, { quoteId: quote.id });
};

// M9.3: "Review and accept" on the public page saves the PO number (if changed), then the buyer goes
// to Shopify's checkout. Returns where to send them: the checkout, or back to the page if it closed.
const acceptPublicQuote = async (request: Request, token: string, poNumber: string) => {
  const { quote, superseded } = await findPublicQuote(request, token);
  if (superseded || quote.status !== "SENT" || !quote.invoiceUrl) return `/q/${token}`;
  if (poNumber.trim() !== (quote.poNumber ?? "")) {
    // Whoever holds the link acts for the quote's contact (as in recordView).
    const actor: CustomerActor = { type: "CUSTOMER", shop: quote.shop, customerId: quote.contactCustomerId ?? "unknown" };
    await savePoNumber(async () => (await unauthenticated.admin(quote.shop)).admin, actor, quote, poNumber);
  }
  return quote.invoiceUrl;
};

export { PUBLIC_HEADERS, acceptPublicQuote, findPublicQuote, notFound, recordView };
export type { ViewSource };
