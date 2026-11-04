// k6 load test (M4.4), not part of the app build. Install k6 on the machine: `winget install k6`.
// 1 000 signed draft_orders/update deliveries in 50 s. Targets: all 200, p95 < 1 s, and the
// process-webhook queue drains in < 5 min (Jobs page / logs).
// Run against a dev tunnel or staging, never production:
//   k6 run -e APP_URL=https://<tunnel-or-staging> -e SHOPIFY_API_SECRET=… -e SHOP=abstore-hixo2jwg.myshopify.com load/webhook-burst.js
/* global __ENV, __VU, __ITER */
import http from "k6/http";
import crypto from "k6/crypto";
import { check } from "k6";

export const options = {
  scenarios: {
    burst: { executor: "constant-arrival-rate", rate: 20, timeUnit: "1s", duration: "50s", preAllocatedVUs: 50 },
  },
  thresholds: { http_req_duration: ["p(95)<1000"], checks: ["rate>0.999"] },
};

const URL = `${__ENV.APP_URL}/webhooks/draft-orders`;
const SECRET = __ENV.SHOPIFY_API_SECRET;
const SHOP = __ENV.SHOP;

export default function () {
  // A random draft order id matches no quote: the job runs its lookup and finds nothing.
  const body = JSON.stringify({
    id: Math.floor(Math.random() * 1e9),
    status: "open",
    order_id: null,
    updated_at: new Date().toISOString(),
    line_items: [],
  });
  const id = `${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(URL, body, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": crypto.hmac("sha256", SECRET, body, "base64"),
      "X-Shopify-Topic": "draft_orders/update",
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Webhook-Id": `load-${id}`,
      "X-Shopify-Event-Id": `load-${id}`,
      "X-Shopify-Triggered-At": new Date().toISOString(),
    },
  });
  check(res, { 200: (r) => r.status === 200 });
}
