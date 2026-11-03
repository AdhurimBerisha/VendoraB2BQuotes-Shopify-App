import { createHmac, timingSafeEqual } from "node:crypto";

// Signed customer links (M3.2): <base64url payload>.<base64url HMAC-SHA256>.
// APP_SIGNING_SECRET_OLD keeps old links working while the secret is rotated.
type QuoteTokenPayload = { shop: string; quoteId: string; version: number; exp: number };

const DAY_MS = 86_400_000;

const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest();

const signQuoteToken = (payload: QuoteTokenPayload): string => {
  const secret = process.env.APP_SIGNING_SECRET;
  if (!secret) throw new Error("APP_SIGNING_SECRET is not set");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(secret, body).toString("base64url")}`;
};

// The payload, or null for anything wrong (format, signature, expiry). Never throws.
const verifyQuoteToken = (token: string, now = Date.now()): QuoteTokenPayload | null => {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const given = Buffer.from(sig, "base64url");
  const secrets = [process.env.APP_SIGNING_SECRET, process.env.APP_SIGNING_SECRET_OLD].filter(
    (secret): secret is string => !!secret,
  );
  const signed = secrets.some((secret) => {
    const expected = hmac(secret, body);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!signed) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null) return null;
    const { shop, quoteId, version, exp } = payload as Record<string, unknown>;
    if (typeof shop !== "string" || typeof quoteId !== "string") return null;
    if (typeof version !== "number" || typeof exp !== "number" || exp <= now) return null;
    return { shop, quoteId, version, exp };
  } catch {
    return null;
  }
};

// Link for a sent version: valid until the quote expires + 7 days to read it, at most 120 days.
const quoteLink = (
  appUrl: string,
  quote: { shop: string; quoteId: string; version: number; expiresAt: Date | null },
  now = Date.now(),
) => {
  const max = now + 120 * DAY_MS;
  const exp = Math.min(max, (quote.expiresAt?.getTime() ?? max) + 7 * DAY_MS);
  const token = signQuoteToken({ shop: quote.shop, quoteId: quote.quoteId, version: quote.version, exp });
  return `${appUrl.replace(/\/$/, "")}/q/${token}`;
};

export { quoteLink, signQuoteToken, verifyQuoteToken };
export type { QuoteTokenPayload };
