import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../db.server";
import { ConflictError, ForbiddenError, NotFoundError, UserError } from "../lib/errors";
import { D } from "../lib/money";
import { fakeShopify } from "../test/fake-shopify";
import { staff, testQuote, testShop } from "../test/factories";
import { redactShop } from "./privacy.server";
import { createQuote, getQuote, setPoNumber, transition } from "./quote.server";
import { saveDraftLines } from "./version.server";

let SHOP: string;
const shopify = fakeShopify({
  variants: {
    "gid://shopify/ProductVariant/1": { price: "10.00" },
    "gid://shopify/ProductVariant/2": { price: "25.50" },
  },
});
const actor = () => staff(SHOP, shopify.admin);

beforeAll(async () => {
  SHOP = (await testShop()).id;
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

// Catalog prices come from the fake: variant 1 = 10.00, variant 2 = 25.50.
const line = (n: number, quantity: number) => ({
  variantId: `gid://shopify/ProductVariant/${n}`,
  quantity,
});

test("20 quotes created at once get numbers 1001…1020, no duplicates", async () => {
  const quotes = await Promise.all(
    Array.from({ length: 20 }, () =>
      createQuote(actor(), { locationId: "gid://shopify/CompanyLocation/1" }),
    ),
  );

  const numbers = quotes.map((quote) => quote.number).sort((a, b) => a - b);
  expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => 1001 + i));
  // Company, contact and currency come from Shopify.
  expect(quotes[0]).toMatchObject({
    companyId: "gid://shopify/Company/1",
    companyContactId: "gid://shopify/CompanyContact/1",
    contactCustomerId: "gid://shopify/Customer/1",
    currencyCode: "USD",
    status: "DRAFT",
  });
});

test("a company without a main contact can't get a quote", async () => {
  const noContact = fakeShopify({
    location: {
      id: "gid://shopify/CompanyLocation/2",
      name: "Main",
      currency: "USD",
      company: { id: "gid://shopify/Company/2", name: "Powderbound", mainContact: null },
    },
  });

  await expect(
    createQuote(staff(SHOP, noContact.admin), { locationId: "gid://shopify/CompanyLocation/2" }),
  ).rejects.toMatchObject({ key: "quote.errors.noMainContact" });
});

test("transition from the wrong status throws ConflictError", async () => {
  const quote = await testQuote(SHOP); // DRAFT

  await expect(
    db.$transaction((tx) => transition(tx, SHOP, quote.id, "approve", "APPROVED")),
  ).rejects.toBeInstanceOf(ConflictError);
  await db.$transaction((tx) => transition(tx, SHOP, quote.id, "submit", "PENDING_APPROVAL"));

  expect((await getQuote(SHOP, quote.id)).status).toBe("PENDING_APPROVAL");
});

test("another shop can't read the quote", async () => {
  const quote = await testQuote(SHOP);

  await expect(getQuote("other-shop.myshopify.com", quote.id)).rejects.toBeInstanceOf(
    NotFoundError,
  );
});

test("saving with a stale lockVersion is rejected", async () => {
  const quote = await testQuote(SHOP);
  await saveDraftLines(actor(), quote.id, 0, [line(1, 1)], null);

  await expect(
    saveDraftLines(actor(), quote.id, 0, [line(1, 2)], null),
  ).rejects.toMatchObject({ key: "quote.errors.changedByOther" });
});

test("two saves with the same lockVersion at once: one wins, lines are the winner's", async () => {
  const quote = await testQuote(SHOP);

  const results = await Promise.allSettled([
    saveDraftLines(actor(), quote.id, 0, [line(1, 3)], null),
    saveDraftLines(actor(), quote.id, 0, [line(2, 7)], null),
  ]);

  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(loser.reason).toMatchObject({ key: "quote.errors.changedByOther" });
  const winner = results[0].status === "fulfilled" ? line(1, 3) : line(2, 7);
  const reloaded = await getQuote(SHOP, quote.id);
  expect(reloaded.lockVersion).toBe(1);
  expect(reloaded.currentVersion!.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }))).toEqual([winner]);
});

test("a locked version can't be edited", async () => {
  const quote = await testQuote(SHOP);
  await db.quoteVersion.update({
    where: { id: quote.currentVersionId! },
    data: { lockedAt: new Date() },
  });

  await expect(
    saveDraftLines(actor(), quote.id, 0, [line(1, 1)], null),
  ).rejects.toMatchObject({ key: "quote.errors.versionLocked" });
});

test("totals: 10 % line discount, price override, 5 % quote discount", async () => {
  const { id } = await createQuote(actor(), { locationId: "gid://shopify/CompanyLocation/1" });

  await saveDraftLines(
    actor(),
    id,
    0,
    [
      { ...line(1, 3), discountPct: D(10) }, // 30.00 − 10 % = 27.00
      { ...line(2, 2), overridePrice: D("24.00") }, // 2 × 24.00 = 48.00
    ],
    D(5), // 75.00 − 3.75
  );

  const version = (await getQuote(SHOP, id)).currentVersion!;
  expect(version.lines.map((l) => l.lineTotal.toFixed(2))).toEqual(["27.00", "48.00"]);
  expect(version.listTotal.toFixed(2)).toBe("81.00"); // 30.00 + 51.00
  expect(version.subtotal.toFixed(2)).toBe("75.00");
  expect(version.total.toFixed(2)).toBe("71.25");
  expect(version.discountTotal.toFixed(2)).toBe("9.75");

  const actions = (await db.auditEvent.findMany({ where: { shop: SHOP, quoteId: id } })).map(
    (event) => event.action,
  );
  expect(actions).toEqual(expect.arrayContaining(["quote.created", "quote.lines_saved"]));
});

test("lines are priced from Shopify: price break, title, problems", async () => {
  const priced = fakeShopify({
    variants: {
      "gid://shopify/ProductVariant/3": {
        price: "50.00",
        priceBreaks: [
          { minimumQuantity: 10, price: "45.00" },
          { minimumQuantity: 20, price: "40.00" },
        ],
      },
      "gid://shopify/ProductVariant/4": {
        price: "5.00",
        quantityRule: { minimum: 5, maximum: null, increment: 5 },
        inventoryQuantity: 2,
      },
      "gid://shopify/ProductVariant/5": { price: "7.00", currencyCode: "CAD", status: "DRAFT" },
    },
  });
  const { id } = await createQuote(staff(SHOP, priced.admin), {
    locationId: "gid://shopify/CompanyLocation/1",
  });

  await saveDraftLines(
    staff(SHOP, priced.admin),
    id,
    0,
    [line(3, 20), line(4, 7), line(5, 1)],
    null,
  );

  const lines = (await getQuote(SHOP, id)).currentVersion!.lines;
  expect(
    lines.map((l) => [l.titleSnapshot, l.catalogPrice.toFixed(2), l.lineTotal.toFixed(2), l.problems]),
  ).toEqual([
    ["Product 3", "50.00", "800.00", null], // 20 × 40.00 break
    ["Product 4", "5.00", "35.00", ["QTY_NOT_INCREMENT", "OUT_OF_STOCK"]],
    ["Product 5", "7.00", "7.00", ["PRODUCT_NOT_ACTIVE", "CURRENCY_MISMATCH"]],
  ]);
});

test("a deleted variant is rejected and nothing is saved", async () => {
  const quote = await testQuote(SHOP);

  await expect(
    saveDraftLines(actor(), quote.id, 0, [line(1, 1), line(99, 1)], null),
  ).rejects.toMatchObject({ key: "quote.errors.variantNotFound" });
  const reloaded = await getQuote(SHOP, quote.id);
  expect(reloaded.lockVersion).toBe(0);
  expect(reloaded.currentVersion!.lines).toHaveLength(1); // testQuote's original line
});

test("a viewer can't create or edit quotes, even bypassing the page", async () => {
  const viewer = staff(SHOP, shopify.admin, "VIEWER");
  const quote = await testQuote(SHOP);

  await expect(
    createQuote(viewer, { locationId: "gid://shopify/CompanyLocation/1" }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(saveDraftLines(viewer, quote.id, 0, [line(1, 1)], null)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
});

test("M9.3: the PO number goes on the quote and only the PO number on its draft order", async () => {
  const draft = shopify.seedDraft({ tags: [], companyId: "gid://shopify/Company/1", locationId: "gid://shopify/CompanyLocation/1" });
  draft.input = { lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 2 }], note: "Vendora Q-1 v1" };
  const quote = await testQuote(SHOP, { overrides: { status: "SENT", draftOrderId: draft.id } });

  await setPoNumber(actor(), quote.id, " PO-77 ");

  expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).poNumber).toBe("PO-77");
  expect(draft.input).toMatchObject({ poNumber: "PO-77", note: "Vendora Q-1 v1", lineItems: [{ quantity: 2 }] });

  await setPoNumber(actor(), quote.id, "");
  expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).poNumber).toBeNull();
  expect(draft.input.poNumber).toBeNull();

  await expect(setPoNumber(actor(), quote.id, "x".repeat(101))).rejects.toBeInstanceOf(UserError);
  await db.quote.update({ where: { id: quote.id }, data: { status: "ORDERED" } });
  await expect(setPoNumber(actor(), quote.id, "PO-78")).rejects.toBeInstanceOf(ConflictError);
});

