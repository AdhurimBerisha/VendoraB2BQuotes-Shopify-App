import { logger } from "../lib/logger.server";
import db from "../db.server";
import { clientIp, rateLimit } from "../lib/rate-limit.server";
import { verifyQuoteToken } from "../lib/signed-token.server";
import { audit } from "./audit.server";
import { notify } from "./notify.server";

// Headers for every /q/* response: not indexed, the token never leaks in a Referer, not cached,
// no MIME sniffing.
const PUBLIC_HEADERS = {
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
};

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

// One "viewed" event (and email to the rep) per quote per day.
const recordView = async (
  quote: { id: string; shop: string; contactCustomerId: string | null; assignedToUserId: bigint | null },
  version: number,
) => {
  const since = new Date(Date.now() - 86_400_000);
  const seen = await db.auditEvent.findFirst({
    where: { shop: quote.shop, quoteId: quote.id, action: "quote.viewed", createdAt: { gte: since } },
    select: { id: true },
  });
  if (seen) return;
  const actor = { type: "CUSTOMER" as const, shop: quote.shop, customerId: quote.contactCustomerId ?? "unknown" };
  await audit(db, actor, quote.id, "quote.viewed", { version });
  await notify(db, quote.shop, "quoteViewed", { kind: "user", userId: quote.assignedToUserId }, { quoteId: quote.id });
};

export { PUBLIC_HEADERS, findPublicQuote, notFound, recordView };
