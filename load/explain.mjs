// EXPLAIN ANALYZE the app's main queries with a big shop (M4.4 §5, M4.6).
// `node --env-file=.env load/explain.mjs [--count=50000] [--plans] [--keep]`
// Fills a throwaway shop with COUNT quotes (1 version, 3 lines, 4 audit events each), runs each
// query once to warm the cache, then EXPLAIN ANALYZE. Target: every query under 100 ms.
// The shop is deleted at the end unless --keep. Local databases only.
import prisma from "@prisma/client";

const args = process.argv.slice(2);
const countArg = args.find((arg) => arg.startsWith("--count="));
const COUNT = countArg ? Number(countArg.split("=")[1]) : 50_000;
const SHOW_PLANS = args.includes("--plans");
const KEEP = args.includes("--keep");
const SLOW_MS = 100;
const SHOP = "load-explain.myshopify.com"; // a constant: safe to put in the SQL below

const host = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1"].includes(host)) {
  console.error("refusing to run: DATABASE_URL must point at a local database (it writes and deletes rows)");
  process.exit(1);
}
if (!Number.isInteger(COUNT) || COUNT < 1 || COUNT > 1_000_000) {
  console.error("--count must be between 1 and 1000000");
  process.exit(1);
}

const db = new prisma.PrismaClient();
const OPEN = "('DRAFT','PENDING_APPROVAL','APPROVED','SENT')";

const cleanUp = async () => {
  await db.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE shop = '${SHOP}'`);
  await db.$executeRawUnsafe(`DELETE FROM "Quote" WHERE shop = '${SHOP}'`); // versions and lines cascade
  await db.$executeRawUnsafe(`DELETE FROM "Shop" WHERE id = '${SHOP}'`);
};

// Statuses round-robin; dates spread over a year; drafts orders on APPROVED/SENT/ORDERED.
const seed = async () => {
  await db.$executeRawUnsafe(`INSERT INTO "Shop" (id, "updatedAt") VALUES ('${SHOP}', now())`);
  await db.$executeRawUnsafe(`
    INSERT INTO "Quote" (id, shop, number, status, "companyId", "companyLocationId", "companyContactId",
      "currencyCode", "expiresAt", "draftOrderId", "syncStatus", attention, "createdAt", "updatedAt")
    SELECT 'lx' || g, '${SHOP}', 1000 + g,
      (ARRAY['DRAFT','PENDING_APPROVAL','APPROVED','SENT','ORDERED','DECLINED','EXPIRED','CANCELLED'])[1 + g % 8],
      'gid://shopify/Company/' || g % 500, 'gid://shopify/CompanyLocation/' || g % 500,
      'gid://shopify/CompanyContact/' || g % 500, 'USD',
      now() + (g % 120 - 60) * interval '1 day',
      CASE WHEN g % 8 IN (2, 3, 4) THEN 'gid://shopify/DraftOrder/' || g END,
      CASE WHEN g % 8 IN (2, 3, 4) THEN 'SYNCED' ELSE 'NONE' END,
      CASE WHEN g % 200 = 0 THEN '[{"code":"PRICE_MISMATCH","at":"2026-01-01T00:00:00Z"}]'::jsonb END,
      now() - (g % 365) * interval '1 day', now() - (g % 365) * interval '1 day' - g * interval '1 second'
    FROM generate_series(1, ${COUNT}) g`);
  await db.$executeRawUnsafe(`
    INSERT INTO "QuoteVersion" (id, "quoteId", "versionNumber", total)
    SELECT 'lv' || g, 'lx' || g, 1, 100 + g % 900 FROM generate_series(1, ${COUNT}) g`);
  await db.$executeRawUnsafe(`UPDATE "Quote" SET "currentVersionId" = 'lv' || substr(id, 3) WHERE shop = '${SHOP}'`);
  await db.$executeRawUnsafe(`
    INSERT INTO "QuoteLine" (id, "versionId", position, "variantId", "productId", "titleSnapshot", quantity, "catalogPrice", "lineTotal")
    SELECT 'll' || g || '-' || p, 'lv' || g, p, 'gid://shopify/ProductVariant/' || (g * 3 + p) % 6000,
      'gid://shopify/Product/' || (g * 3 + p) % 2000, 'Product', 2, 10, 20
    FROM generate_series(1, ${COUNT}) g, generate_series(0, 2) p`);
  await db.$executeRawUnsafe(`
    INSERT INTO "AuditEvent" (id, shop, "quoteId", "actorType", action, "createdAt")
    SELECT 'la' || g || '-' || e, '${SHOP}', 'lx' || g, 'STAFF',
      (ARRAY['quote.created','quote.lines_saved','quote.approved','quote.sent'])[e],
      now() - (g % 365) * interval '1 day' + e * interval '1 minute'
    FROM generate_series(1, ${COUNT}) g, generate_series(1, 4) e`);
  await db.$executeRawUnsafe(`ANALYZE "Quote", "QuoteVersion", "QuoteLine", "AuditEvent"`);
};

// Hand-written equivalents of what Prisma sends (file and function in each name).
const companies = Array.from({ length: 20 }, (_, i) => `'gid://shopify/Company/${i * 7}'`).join(",");
const QUERIES = [
  ["list: all, newest first (quote.server listQuotes)", `SELECT * FROM "Quote" WHERE shop = '${SHOP}' ORDER BY "updatedAt" DESC, id DESC LIMIT 26`],
  ["list: status filter", `SELECT * FROM "Quote" WHERE shop = '${SHOP}' AND status = 'SENT' ORDER BY "updatedAt" DESC, id DESC LIMIT 26`],
  ["list: company search (20 ids)", `SELECT * FROM "Quote" WHERE shop = '${SHOP}' AND "companyId" IN (${companies}) ORDER BY "updatedAt" DESC, id DESC LIMIT 26`],
  ["list: quote number", `SELECT * FROM "Quote" WHERE shop = '${SHOP}' AND number = ${1000 + Math.ceil(COUNT / 2)} ORDER BY "updatedAt" DESC, id DESC LIMIT 26`],
  ["list: totals of the page", `SELECT id, total, "versionNumber" FROM "QuoteVersion" WHERE id IN ('lv1','lv2','lv3','lv4','lv5')`],
  ["dashboard: count by status", `SELECT status, count(*) FROM "Quote" WHERE shop = '${SHOP}' GROUP BY status`],
  ["dashboard: needs attention", `SELECT id, number, attention FROM "Quote" WHERE shop = '${SHOP}' AND ("syncStatus" IN ('FAILED','NEEDS_ATTENTION') OR attention IS NOT NULL) ORDER BY "updatedAt" DESC LIMIT 20`],
  ["dashboard: pending approval", `SELECT id, number FROM "Quote" WHERE shop = '${SHOP}' AND status = 'PENDING_APPROVAL' ORDER BY "updatedAt" ASC LIMIT 10`],
  ["dashboard: expiring soon", `SELECT id, number FROM "Quote" WHERE shop = '${SHOP}' AND status IN ('APPROVED','SENT') AND "expiresAt" <= now() + interval '7 days' ORDER BY "expiresAt" ASC LIMIT 10`],
  ["dashboard: ordered this month", `SELECT count(*) FROM "Quote" WHERE shop = '${SHOP}' AND status = 'ORDERED' AND "updatedAt" >= date_trunc('month', now())`],
  ["dashboard: sent this month (audit)", `SELECT count(*) FROM "AuditEvent" WHERE shop = '${SHOP}' AND action = 'quote.sent' AND "createdAt" >= date_trunc('month', now())`],
  ["quote page: lines of a version", `SELECT * FROM "QuoteLine" WHERE "versionId" = 'lv${Math.ceil(COUNT / 2)}' ORDER BY position ASC`],
  ["quote page: history (audit)", `SELECT * FROM "AuditEvent" WHERE shop = '${SHOP}' AND "quoteId" = 'lx${Math.ceil(COUNT / 2)}' ORDER BY "createdAt" ASC`],
  ["webhook: quote by draft order", `SELECT * FROM "Quote" WHERE shop = '${SHOP}' AND "draftOrderId" = 'gid://shopify/DraftOrder/10' LIMIT 1`],
  ["webhook: lines of a product (onProductGone)", `SELECT l.id FROM "QuoteLine" l JOIN "Quote" q ON q."currentVersionId" = l."versionId" WHERE l."productId" = 'gid://shopify/Product/7' AND q.shop = '${SHOP}' AND q.status IN ${OPEN}`],
  ["job: expire due quotes (expire-quotes)", `SELECT id, shop FROM "Quote" WHERE status IN ${OPEN} AND "expiresAt" < now() AND shop IN ('${SHOP}') ORDER BY id ASC LIMIT 200`],
  ["job: expiry reminders", `SELECT id, shop FROM "Quote" WHERE status IN ('APPROVED','SENT') AND "expiresAt" >= now() AND "expiresAt" < now() + interval '3 days' AND shop IN ('${SHOP}')`],
  ["job: reconcile candidates", `SELECT id FROM "Quote" WHERE shop = '${SHOP}' AND "draftOrderId" IS NOT NULL AND status IN ('APPROVED','SENT')`],
];

const SCAN = /(Seq Scan|Index Only Scan|Index Scan|Bitmap Heap Scan)(?: Backward)?(?: using (\S+))? on "?(\w+)"?/g;

const explain = async (sql) => {
  await db.$queryRawUnsafe(sql); // warm the cache
  const rows = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
  const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
  const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? NaN);
  const scans = [...new Set([...plan.matchAll(SCAN)].map(([, kind, index, table]) => (index ? `${kind} ${index}` : `${kind} on ${table}`)))];
  return { ms, scans, plan };
};

const main = async () => {
  await cleanUp(); // a previous --keep run
  const started = Date.now();
  await seed();
  console.log(`seeded ${COUNT} quotes in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);

  let slow = 0;
  for (const [name, sql] of QUERIES) {
    const { ms, scans, plan } = await explain(sql);
    const flags = [ms > SLOW_MS ? "SLOW" : "", scans.some((scan) => scan.startsWith("Seq Scan")) ? "SEQ" : ""].filter(Boolean);
    if (ms > SLOW_MS) slow++;
    console.log(`${ms.toFixed(1).padStart(8)} ms  ${name.padEnd(46)} ${flags.join(" ").padEnd(8)} ${scans.join(", ")}`);
    if (SHOW_PLANS || flags.length) console.log(`${plan.replace(/^/gm, "            ")}\n`);
  }
  console.log(`\n${slow === 0 ? "all queries" : `${slow} quer${slow === 1 ? "y" : "ies"} NOT`} under ${SLOW_MS} ms`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!KEEP) await cleanUp().catch((error) => console.error("clean-up failed", error));
    await db.$disconnect();
  });
