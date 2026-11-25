import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../../db.server";
import { enqueue } from "../../jobs/queue.server";
import { signQuoteToken } from "../../lib/signed-token.server";
import { redactShop } from "../../models/privacy.server";
import { recordView } from "../../models/public-quote.server";
import { testQuote, testShop } from "../../test/factories";
import { action, loader } from "./route";

vi.mock("../../jobs/queue.server", () => ({ enqueue: vi.fn(async () => "job-id"), getBoss: vi.fn(async () => ({})) }));
const enqueueMock = vi.mocked(enqueue);

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

test("valid token: lines shown, viewed logged once per hour", async () => {
  const quote = await testQuote(SHOP_A, { lines: 2, overrides: { status: "SENT", invoiceUrl: "https://shop.test/invoice" } });
  const token = tokenFor(SHOP_A, quote.id);

  const result = await get(token);
  await get(token);

  expect(result.data.superseded).toBe(false);
  expect(result.data.quote?.lines).toHaveLength(2);
  expect(result.data.quote?.invoiceUrl).toBe("https://shop.test/invoice");
  expect(result.init?.headers).toMatchObject({ "X-Robots-Tag": "noindex", "Referrer-Policy": "same-origin" });
  expect(await views(SHOP_A, quote.id)).toBe(1);
});

test("M10.3: one view per hour, the rep's email at most once a day; source stored", async () => {
  const REP = 77n;
  await db.staffMember.create({ data: { shop: SHOP_A, shopifyUserId: REP, displayName: "Rep", email: "rep@shop.test" } });
  const quote = await testQuote(SHOP_A, { overrides: { status: "SENT", assignedToUserId: REP } });
  const HOUR = 3_600_000;
  // Moves the views recorded so far back in time (createdAt comes from the database clock).
  const age = async (ms: number) => {
    const events = await db.auditEvent.findMany({ where: { quoteId: quote.id, action: "quote.viewed" } });
    for (const event of events) {
      await db.auditEvent.update({ where: { id: event.id }, data: { createdAt: new Date(event.createdAt.getTime() - ms) } });
    }
  };
  const emails = () =>
    enqueueMock.mock.calls.filter(([queue, data]) => queue === "send-email" && (data as { type: string }).type === "quoteViewed").length;
  enqueueMock.mockClear();

  await recordView(quote, 1, "page");
  await recordView(quote, 1, "pdf"); // same hour: ignored
  expect(await views(SHOP_A, quote.id)).toBe(1);
  expect(emails()).toBe(1);

  await age(2 * HOUR);
  await recordView(quote, 1, "pdf"); // new event, but emailed within the day already
  expect(await views(SHOP_A, quote.id)).toBe(2);
  expect(emails()).toBe(1);

  await age(25 * HOUR);
  await recordView(quote, 1, "account"); // no view in the last day: email again
  expect(await views(SHOP_A, quote.id)).toBe(3);
  expect(emails()).toBe(2);

  const sources = await db.auditEvent.findMany({ where: { quoteId: quote.id, action: "quote.viewed" }, orderBy: { createdAt: "asc" } });
  expect(sources.map((event) => (event.data as { source: string }).source)).toEqual(["page", "pdf", "account"]);
});

const accept = (token: string, poNumber: string) =>
  action({
    request: new Request(`https://vendora.test/q/${token}`, {
      method: "POST",
      headers: { "x-forwarded-for": randomUUID(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ poNumber }),
    }),
    params: { token },
    context: {},
  } as unknown as Parameters<typeof action>[0]);

test("M9.3: accept saves the PO number and goes to checkout; a closed quote goes back to the page", async () => {
  const quote = await testQuote(SHOP_A, { overrides: { status: "SENT", invoiceUrl: "https://shop.test/invoice" } });
  const token = tokenFor(SHOP_A, quote.id);

  const response = await accept(token, "  PO-4711 ");

  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("https://shop.test/invoice");
  expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).poNumber).toBe("PO-4711");
  expect(await db.auditEvent.count({ where: { shop: SHOP_A, quoteId: quote.id, action: "quote.po_number_set" } })).toBe(1);
  expect((await get(token)).data.quote?.poNumber).toBe("PO-4711");

  // Same number again: nothing to save.
  await accept(token, "PO-4711");
  expect(await db.auditEvent.count({ where: { shop: SHOP_A, quoteId: quote.id, action: "quote.po_number_set" } })).toBe(1);

  await db.quote.update({ where: { id: quote.id }, data: { status: "ORDERED" } });
  const closed = await accept(token, "PO-9");
  expect(closed.headers.get("Location")).toBe(`/q/${token}`);
  expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).poNumber).toBe("PO-4711");
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
