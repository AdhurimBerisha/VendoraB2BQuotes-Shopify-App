import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../../db.server";
import { signQuoteToken } from "../../lib/signed-token.server";
import { redactShop } from "../../models/privacy.server";
import { testQuote, testShop } from "../../test/factories";
import { loader } from "./route";

let SHOP_A: string;
let SHOP_B: string;

beforeAll(async () => {
  SHOP_A = (await testShop()).id;
  SHOP_B = (await testShop()).id;
});

afterAll(async () => {
  await redactShop(SHOP_A);
  await redactShop(SHOP_B);
  await db.$disconnect();
});

const tokenFor = (shop: string, quoteId: string, version = 1) =>
  signQuoteToken({ shop, quoteId, version, exp: Date.now() + 60_000 });

// Each call gets its own IP unless given one, so the rate limit doesn't leak between tests.
const get = (token: string, ip = randomUUID()) =>
  loader({
    request: new Request(`https://vendora.test/q/${token}`, { headers: { "x-forwarded-for": ip } }),
    params: { token },
    context: {},
  } as unknown as Parameters<typeof loader>[0]);

const statusOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof Response) return error.status;
    throw error;
  }
};

const views = (shop: string, quoteId: string) =>
  db.auditEvent.count({ where: { shop, quoteId, action: "quote.viewed" } });

test("valid token: lines shown, viewed logged once per day", async () => {
  const quote = await testQuote(SHOP_A, { lines: 2, overrides: { status: "SENT", invoiceUrl: "https://shop.test/invoice" } });
  const token = tokenFor(SHOP_A, quote.id);

  const result = await get(token);
  await get(token);

  expect(result.data.superseded).toBe(false);
  expect(result.data.quote?.lines).toHaveLength(2);
  expect(result.data.quote?.invoiceUrl).toBe("https://shop.test/invoice");
  expect(result.init?.headers).toMatchObject({ "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" });
  expect(await views(SHOP_A, quote.id)).toBe(1);
});

test("no checkout link unless the quote is SENT", async () => {
  const quote = await testQuote(SHOP_A, { overrides: { status: "ACCEPTED", invoiceUrl: "https://shop.test/invoice" } });
  const result = await get(tokenFor(SHOP_A, quote.id));
  expect(result.data.quote?.invoiceUrl).toBeNull();
});

test("a token for shop A with shop B's quote id → 404 (scenario 4)", async () => {
  const quoteOfB = await testQuote(SHOP_B);
  expect(await statusOf(get(tokenFor(SHOP_A, quoteOfB.id)))).toBe(404);
});

test("v1 link after v2 exists: superseded, no lines or total", async () => {
  const quote = await testQuote(SHOP_A, { overrides: { status: "SENT" } });
  const v2 = await db.quoteVersion.create({ data: { quoteId: quote.id, versionNumber: 2 } });
  await db.quote.update({ where: { id: quote.id }, data: { currentVersionId: v2.id } });

  const result = await get(tokenFor(SHOP_A, quote.id, 1));

  expect(result.data).toEqual({ superseded: true, label: expect.any(String), version: 1, quote: null });
  expect(await views(SHOP_A, quote.id)).toBe(0);
});

test("tampered and unknown-version tokens → 404", async () => {
  const quote = await testQuote(SHOP_A);
  const token = tokenFor(SHOP_A, quote.id);
  expect(await statusOf(get(`${token}x`))).toBe(404);
  expect(await statusOf(get(tokenFor(SHOP_A, quote.id, 9)))).toBe(404);
});

test("uninstalled shop → 404", async () => {
  const shop = await testShop({ uninstalledAt: new Date() });
  const quote = await testQuote(shop.id);
  expect(await statusOf(get(tokenFor(shop.id, quote.id)))).toBe(404);
  await redactShop(shop.id);
});

test("61st request in a minute from one IP → 429", async () => {
  const ip = randomUUID();
  for (let i = 0; i < 60; i++) expect(await statusOf(get("bad", ip))).toBe(404);
  expect(await statusOf(get("bad", ip))).toBe(429);
});
