import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../db.server";
import { staff, testQuote, testShop } from "../test/factories";
import { fakeShopify } from "../test/fake-shopify";
import { redactShop } from "./privacy.server";
import { assertB2b, checkB2b, missingScopes, orB2bLost, takeWelcomeBack, upsertShopOnInstall } from "./shop.server";
import { requestSync, runSync } from "./sync.server";
import { ShopifyDenied } from "../shopify/client.server";

// M5.3 install edge cases: reinstall before shop/redact, a store that loses B2B, changed scopes.

vi.mock("../jobs/queue.server", () => ({ enqueue: vi.fn(async () => "job-id"), getBoss: vi.fn(async () => ({})) }));

const shops: string[] = [];
const newShop = async (overrides: Parameters<typeof testShop>[0] = {}) => {
  const shop = await testShop(overrides);
  shops.push(shop.id);
  return shop.id;
};
const flag = async (shop: string) => (await db.shop.findUniqueOrThrow({ where: { id: shop } })).b2bUnavailable;

let scopesBefore: string | undefined;
beforeAll(() => {
  scopesBefore = process.env.SCOPES;
  process.env.SCOPES = "read_products,read_customers,write_draft_orders";
});
afterAll(async () => {
  process.env.SCOPES = scopesBefore;
  for (const shop of shops) await redactShop(shop);
  await db.$disconnect();
});

test("reinstall before shop/redact: quotes intact, uninstalledAt cleared, welcome back shown once", async () => {
  const shop = await newShop({ uninstalledAt: new Date(), b2bUnavailable: true });
  const quote = await testQuote(shop);

  expect(await upsertShopOnInstall(fakeShopify().admin, shop)).toEqual({ reinstalled: true });

  const saved = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  expect(saved.uninstalledAt).toBeNull();
  expect(saved.b2bUnavailable).toBe(false); // checked again from scratch
  expect(await db.quote.count({ where: { id: quote.id } })).toBe(1);
  expect(await takeWelcomeBack(shop)).toBe(true);
  expect(await takeWelcomeBack(shop)).toBe(false);

  // The next auth (token refresh) isn't a reinstall.
  expect(await upsertShopOnInstall(fakeShopify().admin, shop)).toEqual({ reinstalled: false });
  expect(await takeWelcomeBack(shop)).toBe(false);
});

test("first install (or after shop/redact deleted everything): no welcome back, wizard from the start", async () => {
  const shop = `vitest-${randomUUID()}.myshopify.com`;
  shops.push(shop);

  expect(await upsertShopOnInstall(fakeShopify().admin, shop)).toEqual({ reinstalled: false });

  const saved = await db.shop.findUniqueOrThrow({ where: { id: shop } });
  expect(saved.welcomeBack).toBe(false);
  expect(saved.onboardingStep).toBe("WELCOME");
});

test("store loses B2B: flagged, syncing and sending refused, cleared when B2B is back", async () => {
  const shop = await newShop();
  const shopify = fakeShopify();
  const quote = await testQuote(shop);

  shopify.failNext("VendoraCompanySearch", "accessDenied");
  expect(await checkB2b(shopify.admin, shop)).toBe(false);
  expect(await flag(shop)).toBe(true);
  await expect(assertB2b(shop)).rejects.toMatchObject({ key: "eligibility.errors.b2bUnavailable" });
  await expect(requestSync(staff(shop, shopify.admin), quote.id)).rejects.toMatchObject({
    key: "eligibility.errors.b2bUnavailable",
  });
  expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).syncStatus).toBe("NONE");

  expect(await checkB2b(shopify.admin, shop)).toBe(true);
  expect(await flag(shop)).toBe(false);
  await requestSync(staff(shop, shopify.admin), quote.id);
  expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).syncStatus).toBe("QUEUED");
});

test("a sync denied because B2B is gone flags the shop; a denied sync on a B2B store doesn't", async () => {
  const shop = await newShop();
  const job = (quoteId: string) => ({ shop, quoteId, op: "upsert" as const });

  // Missing scope: the draft order is refused, companies still answer.
  const scopeProblem = fakeShopify();
  scopeProblem.failNext("VendoraDraftOrderCreate", "accessDenied");
  const first = await testQuote(shop, { overrides: { syncStatus: "QUEUED" } });
  await runSync(scopeProblem.admin, job(first.id));
  expect((await db.quote.findUniqueOrThrow({ where: { id: first.id } })).syncStatus).toBe("FAILED");
  expect(await flag(shop)).toBe(false);

  // No B2B: companies are refused too.
  const noB2b = fakeShopify();
  noB2b.failNext("VendoraDraftOrderCreate", "accessDenied");
  noB2b.failNext("VendoraCompanySearch", "accessDenied");
  const second = await testQuote(shop, { overrides: { syncStatus: "QUEUED" } });
  await runSync(noB2b.admin, job(second.id));
  expect((await db.quote.findUniqueOrThrow({ where: { id: second.id } })).syncStatus).toBe("FAILED");
  expect(await flag(shop)).toBe(true);
});

test("orB2bLost: a denied company read flags the shop and gives the fallback; other errors pass through", async () => {
  const shop = await newShop();

  expect(await orB2bLost(shop, "fallback", async () => "read")).toBe("read");
  expect(await flag(shop)).toBe(false);

  const denied = orB2bLost(shop, "fallback", async () => {
    throw new ShopifyDenied("no companies");
  });
  expect(await denied).toBe("fallback");
  expect(await flag(shop)).toBe(true);

  const broken = orB2bLost(shop, "fallback", async () => {
    throw new Error("network");
  });
  await expect(broken).rejects.toThrow("network");
});

test("missingScopes: what SCOPES asks for and the session lacks; write_x covers read_x", () => {
  expect(missingScopes("read_products,read_customers,write_draft_orders")).toEqual([]);
  expect(missingScopes("write_products, read_customers, write_draft_orders")).toEqual([]);
  expect(missingScopes("read_products,write_draft_orders")).toEqual(["read_customers"]);
  expect(missingScopes(undefined)).toEqual(["read_products", "read_customers", "write_draft_orders"]);
});
