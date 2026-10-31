import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../db.server";
import { redactShop } from "../models/privacy.server";
import { fakeShopify } from "../test/fake-shopify";
import { staff, testQuote, testShop } from "../test/factories";
import { action } from "./app.quotes.$id";

// The route's action parsing, with getActor replaced by a test staff member.
let SHOP: string;
vi.mock("../models/actor.server", () => ({
  getActor: vi.fn(async () => staff(SHOP, fakeShopify({ variants: { "gid://shopify/ProductVariant/1": { price: "10.00" } } }).admin)),
}));
vi.mock("../jobs/queue.server", () => ({ enqueue: vi.fn(async () => "job-id"), getBoss: vi.fn(async () => ({})) }));

beforeAll(async () => {
  SHOP = (await testShop()).id;
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

const post = (quoteId: string, fields: Record<string, string>) =>
  action({
    request: new Request(`https://vendora.test/app/quotes/${quoteId}`, { method: "POST", body: new URLSearchParams(fields) }),
    params: { id: quoteId },
    context: {},
  } as unknown as Parameters<typeof action>[0]);

test("an unknown intent is rejected as invalid input", async () => {
  const quote = await testQuote(SHOP);
  const result = await post(quote.id, { intent: "deleteEverything" });
  expect(result).toMatchObject({ ok: false, error: { key: "errors.invalidInput" } });
});

test("bad lines are rejected before anything is saved", async () => {
  const quote = await testQuote(SHOP);
  for (const lines of [
    "not json",
    JSON.stringify([{ variantId: "gid://shopify/Product/1", quantity: 1, overridePrice: "", discountPct: "" }]),
    JSON.stringify([{ variantId: "gid://shopify/ProductVariant/1", quantity: 0, overridePrice: "", discountPct: "" }]),
    JSON.stringify([{ variantId: "gid://shopify/ProductVariant/1", quantity: 1, overridePrice: "-1", discountPct: "" }]),
    JSON.stringify([{ variantId: "gid://shopify/ProductVariant/1", quantity: 1, overridePrice: "", discountPct: "101" }]),
  ]) {
    const result = await post(quote.id, { intent: "saveLines", lockVersion: "0", lines, quoteDiscountPct: "" });
    expect(result).toMatchObject({ ok: false, error: { key: "errors.invalidInput" } });
  }
  expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).lockVersion).toBe(0);
});

test("valid lines are saved with prices from Shopify", async () => {
  const quote = await testQuote(SHOP);
  const lines = JSON.stringify([
    { variantId: "gid://shopify/ProductVariant/1", quantity: "3", overridePrice: "9,5", discountPct: "10" },
  ]);

  const result = await post(quote.id, { intent: "saveLines", lockVersion: "0", lines, quoteDiscountPct: "5" });

  expect(result).toEqual({ ok: true, data: { intent: "saveLines" } });
  const [line] = await db.quoteLine.findMany({ where: { versionId: quote.currentVersionId! } });
  expect(line.quantity).toBe(3);
  expect(line.overridePrice?.toString()).toBe("9.5");
  expect(line.discountPct?.toString()).toBe("10");
});
