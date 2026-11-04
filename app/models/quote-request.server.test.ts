import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../db.server";
import { ForbiddenError, UserError } from "../lib/errors";
import { fakeShopify } from "../test/fake-shopify";
import { testShop } from "../test/factories";
import { redactShop } from "./privacy.server";
import { requestQuoteFromStorefront } from "./quote-request.server";

let SHOP: string;
const CUSTOMER = "gid://shopify/Customer/42";
const variants = { "gid://shopify/ProductVariant/11": { price: "12.50" }, "gid://shopify/ProductVariant/12": { price: "4.00" } };
const body = {
  locationId: "1",
  message: "  Need these by Friday  ",
  lines: [
    { variantId: 11, quantity: 3 },
    { variantId: 12, quantity: 5 },
  ],
};

beforeAll(async () => {
  SHOP = (await testShop({ quotePrefix: "RQ-" })).id;
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

test("the button's cart becomes an unassigned DRAFT quote priced by Shopify, with the buyer's message", async () => {
  const label = await requestQuoteFromStorefront(fakeShopify({ variants }).admin, SHOP, CUSTOMER, body);

  const quote = await db.quote.findFirstOrThrow({
    where: { shop: SHOP },
    orderBy: { createdAt: "desc" },
    include: { currentVersion: { include: { lines: { orderBy: { position: "asc" } } } } },
  });
  expect(label).toBe(`RQ-${quote.number}`);
  expect(quote.status).toBe("DRAFT");
  expect(quote.syncStatus).toBe("NONE");
  expect(quote.draftOrderId).toBeNull();
  expect(quote.assignedToUserId).toBeNull();
  expect(quote.companyLocationId).toBe("gid://shopify/CompanyLocation/1");
  expect(quote.companyContactId).toBe("gid://shopify/CompanyContact/7"); // the buyer's own contact
  expect(quote.contactCustomerId).toBe(CUSTOMER);
  expect(quote.currentVersion?.internalNote).toBe("Need these by Friday");
  expect(quote.currentVersion?.total.toString()).toBe("57.5");
  expect(quote.currentVersion?.lines.map((line) => [line.variantId, line.quantity])).toEqual([
    ["gid://shopify/ProductVariant/11", 3],
    ["gid://shopify/ProductVariant/12", 5],
  ]);
  const [created] = await db.auditEvent.findMany({ where: { quoteId: quote.id, action: "quote.created" } });
  expect(created.actorType).toBe("CUSTOMER");
  expect(created.data).toMatchObject({ source: "storefront_button" });
});

test("a location where the buyer has no role is refused; nothing is created", async () => {
  const before = await db.quote.count({ where: { shop: SHOP } });
  const fake = fakeShopify({ variants, buyerLocations: ["gid://shopify/CompanyLocation/2"] });

  await expect(requestQuoteFromStorefront(fake.admin, SHOP, CUSTOMER, body)).rejects.toThrow(ForbiddenError);
  expect(await db.quote.count({ where: { shop: SHOP } })).toBe(before);
});

test("bad input (no lines, zero quantity, too many lines) is a UserError", async () => {
  const admin = fakeShopify({ variants }).admin;
  const tooMany = Array.from({ length: 101 }, (_, index) => ({ variantId: index + 1, quantity: 1 }));
  for (const bad of [{ ...body, lines: [] }, { ...body, lines: [{ variantId: 11, quantity: 0 }] }, { ...body, lines: tooMany }, null]) {
    await expect(requestQuoteFromStorefront(admin, SHOP, CUSTOMER, bad)).rejects.toThrow(UserError);
  }
});
