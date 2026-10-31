import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../db.server";
import { redactShop } from "../models/privacy.server";
import { testQuote, testShop } from "../test/factories";
import { enqueue } from "./queue.server";
import { runExpireQuotes } from "./expire-quotes.server";

vi.mock("./queue.server", () => ({ enqueue: vi.fn(async () => "job-id"), getBoss: vi.fn(async () => ({})) }));
const enqueueMock = vi.mocked(enqueue);

let SHOP: string;
let UNINSTALLED: string;
const MINUTE = 60_000;

beforeAll(async () => {
  SHOP = (await testShop()).id;
  UNINSTALLED = (await testShop({ uninstalledAt: new Date() })).id;
});

beforeEach(() => enqueueMock.mockClear());

afterAll(async () => {
  await redactShop(SHOP);
  await redactShop(UNINSTALLED);
  await db.$disconnect();
});

const load = (id: string) => db.quote.findUniqueOrThrow({ where: { id } });
const actions = async (quoteId: string) =>
  (await db.auditEvent.findMany({ where: { quoteId }, orderBy: { createdAt: "asc" } })).map((event) => event.action);

test("SENT quote 1 min past expiry with a draft order: EXPIRED, delete queued, audited", async () => {
  const quote = await testQuote(SHOP, {
    overrides: { status: "SENT", expiresAt: new Date(Date.now() - MINUTE), draftOrderId: "gid://shopify/DraftOrder/9", syncStatus: "SYNCED" },
  });

  await runExpireQuotes();

  const saved = await load(quote.id);
  expect(saved.status).toBe("EXPIRED");
  expect(saved.syncStatus).toBe("QUEUED");
  expect(enqueueMock).toHaveBeenCalledWith(
    "sync-draft-order",
    { shop: SHOP, quoteId: quote.id, op: "delete" },
    expect.objectContaining({ singletonKey: `${quote.id}:delete` }),
  );
  expect(await actions(quote.id)).toEqual(["quote.expired"]);
});

test("a quote expiring tomorrow is untouched", async () => {
  const quote = await testQuote(SHOP, { overrides: { status: "DRAFT", expiresAt: new Date(Date.now() + 1440 * MINUTE) } });

  await runExpireQuotes();

  expect((await load(quote.id)).status).toBe("DRAFT");
});

test("an ORDERED quote with a past expiry is untouched", async () => {
  const quote = await testQuote(SHOP, { overrides: { status: "ORDERED", expiresAt: new Date(Date.now() - MINUTE) } });

  await runExpireQuotes();

  expect((await load(quote.id)).status).toBe("ORDERED");
});

test("an uninstalled shop's quotes are untouched", async () => {
  const quote = await testQuote(UNINSTALLED, { overrides: { status: "SENT", expiresAt: new Date(Date.now() - MINUTE) } });

  await runExpireQuotes();

  expect((await load(quote.id)).status).toBe("SENT");
});

test("reminder: once per expiry date, again after the date changes", async () => {
  const quote = await testQuote(SHOP, { overrides: { status: "SENT", expiresAt: new Date(Date.now() + 1440 * MINUTE) } });

  await runExpireQuotes();
  await runExpireQuotes();
  expect(await actions(quote.id)).toEqual(["quote.expiry_reminded"]);

  await db.quote.update({ where: { id: quote.id }, data: { expiresAt: new Date(Date.now() + 2880 * MINUTE) } });
  await runExpireQuotes();
  expect(await actions(quote.id)).toEqual(["quote.expiry_reminded", "quote.expiry_reminded"]);
});
