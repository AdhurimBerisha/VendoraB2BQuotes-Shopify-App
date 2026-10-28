import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../db.server";
import { ConflictError, NotFoundError } from "../lib/errors";
import { D } from "../lib/money";
import { fakeShopify } from "../test/fake-shopify";
import { staff, testQuote, testShop } from "../test/factories";
import { redactShop } from "./privacy.server";
import { createQuote, getQuote, transition } from "./quote.server";
import { saveDraftLines } from "./version.server";

let SHOP: string;
const shopify = fakeShopify();
const actor = () => staff(SHOP, shopify.admin);

beforeAll(async () => {
  SHOP = (await testShop()).id;
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

const line = (n: number, quantity: number, price: string) => ({
  variantId: `gid://shopify/ProductVariant/${n}`,
  productId: `gid://shopify/Product/${n}`,
  sku: null,
  title: `Product ${n}`,
  quantity,
  catalogPrice: D(price),
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
  await saveDraftLines(actor(), quote.id, 0, [line(1, 1, "10")], null);

  await expect(
    saveDraftLines(actor(), quote.id, 0, [line(1, 2, "10")], null),
  ).rejects.toMatchObject({ key: "quote.errors.changedByOther" });
});

test("a locked version can't be edited", async () => {
  const quote = await testQuote(SHOP);
  await db.quoteVersion.update({
    where: { id: quote.currentVersionId! },
    data: { lockedAt: new Date() },
  });

  await expect(
    saveDraftLines(actor(), quote.id, 0, [line(1, 1, "10")], null),
  ).rejects.toMatchObject({ key: "quote.errors.versionLocked" });
});

test("totals: 10 % line discount, price override, 5 % quote discount", async () => {
  const { id } = await createQuote(actor(), { locationId: "gid://shopify/CompanyLocation/1" });

  await saveDraftLines(
    actor(),
    id,
    0,
    [
      { ...line(1, 3, "10.00"), discountPct: D(10) }, // 30.00 − 10 % = 27.00
      { ...line(2, 2, "25.50"), overridePrice: D("24.00") }, // 2 × 24.00 = 48.00
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
