// ponytail: in-memory, per process; with several instances, move to a Postgres or Redis counter.
const buckets = new Map<string, { count: number; resetAt: number }>();

// true = allowed. `limit` requests per `windowMs` per key.
const rateLimit = (key: string, limit = 60, windowMs = 60_000, now = Date.now()): boolean => {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size > 50_000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count++;
  return bucket.count <= limit;
};

const clientIp = (request: Request) =>
  request.headers.get("cf-connecting-ip") ??
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  "unknown";

export { clientIp, rateLimit };
