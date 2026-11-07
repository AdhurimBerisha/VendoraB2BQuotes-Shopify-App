# Load tests (M4.4)

Not part of the app build. Run against a dev tunnel or staging, never production.

## Database at 50 000 quotes
`node --env-file=.env load/explain.mjs` (options: `--count=100000`, `--plans` for every plan, `--keep` to leave the data).
Local database only (it refuses any other host). It fills the shop `load-explain.myshopify.com` with quotes,
versions, lines and audit events, runs the main queries of the list, dashboard, quote page, webhooks and jobs,
and prints each one's time and which index it used. Target: every query under 100 ms; `SLOW` and `SEQ`
(a full table scan) lines also print their plan. The shop is deleted at the end. Start Docker and run
`npx prisma migrate deploy` first.

## Webhook burst
`k6 run -e APP_URL=… -e SHOPIFY_API_SECRET=… -e SHOP=… load/webhook-burst.js`
Targets: 1 000 deliveries in 50 s, all 200, p95 < 1 s; the `process-webhook` queue drains in < 5 min (Jobs page).

## 10 000-row CSV import
1. `node load/make-csv.mjs <real dev-store SKUs, comma separated> 10000 > load/big.csv`
2. Upload it on a draft quote (Import CSV). Time it until the import is READY: target < 60 s. Watch server memory: target < 512 MB.
3. Commit it; the quote has one merged line per SKU.

## Concurrent edits
k6 can't get Shopify session tokens, so concurrency is tested at the model level
(`quote.server.test.ts`, `version.server.test.ts`). By hand: open the same draft quote in two
browsers, save lines in one, then save in the other → "Someone else changed this quote" with
"Reload latest" / "Save mine anyway".
