import { logger } from "../lib/logger.server";
import type { ActionFunctionArgs } from "react-router";
import { UserError } from "../lib/errors";
import { rateLimit } from "../lib/rate-limit.server";
import { requestQuoteFromStorefront } from "../models/quote-request.server";
import { authenticate } from "../shopify.server";

// POST /apps/vendora/quote-request (app proxy → /proxy/quote-request), from the theme's
// "Request a quote" block (M3.5 Option 2). Shopify signs the request and adds the logged-in
// customer's id; the library checks the signature.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) return Response.json({ error: "failed" }, { status: 503 }); // app not installed
  const customerId = new URL(request.url).searchParams.get("logged_in_customer_id");
  if (!customerId) return Response.json({ error: "forbidden" }, { status: 401 });
  // JSON only: a cross-site form post can't send it without CORS, so other sites can't
  // request quotes in a logged-in buyer's name.
  // Exact type match: "text/plain; x=application/json" is a simple request and must not pass.
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return Response.json({ error: "failed" }, { status: 415 });
  }
  if (!rateLimit(`rfq:${session.shop}:${customerId}`, 5)) {
    return Response.json({ error: "rateLimited" }, { status: 429 });
  }

  try {
    const body = await request.json().catch(() => null);
    const quoteLabel = await requestQuoteFromStorefront(admin, session.shop, `gid://shopify/Customer/${customerId}`, body);
    return Response.json({ quoteLabel });
  } catch (error) {
    // ForbiddenError (no role at that location) → 403, bad input or unknown variant → 400.
    if (error instanceof UserError) {
      return Response.json({ error: error.status === 403 ? "forbidden" : "failed" }, { status: error.status });
    }
    logger.error({ shop: session.shop, error }, "quote request failed");
    return Response.json({ error: "failed" }, { status: 500 });
  }
};
