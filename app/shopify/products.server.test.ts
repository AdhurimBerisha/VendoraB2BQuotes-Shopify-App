import { expect, test } from "vitest";
import { fakeShopify } from "../test/fake-shopify";
import { canViewCosts } from "./products.server";

// M10.2: Shopify's "View product costs" decides; the answer is cached per staff member for 10 minutes.
test("canViewCosts: allowed, refused, cached", async () => {
  const shopify = fakeShopify();
  const now = 1_000_000;
  expect(await canViewCosts(shopify.admin, "a.myshopify.com", "1", now)).toBe(true);

  shopify.failNext("VendoraCanViewCosts", "accessDenied");
  expect(await canViewCosts(shopify.admin, "a.myshopify.com", "2", now)).toBe(false);
  expect(await canViewCosts(shopify.admin, "a.myshopify.com", "2", now + 60_000)).toBe(false); // cached
  expect(shopify.callsOf("VendoraCanViewCosts")).toBe(2);

  expect(await canViewCosts(shopify.admin, "a.myshopify.com", "2", now + 11 * 60_000)).toBe(true); // asked again
});

test("canViewCosts: other Shopify errors aren't read as 'no access'", async () => {
  const shopify = fakeShopify();
  shopify.failNext("VendoraCanViewCosts", "http500", "http500", "http500", "http500", "http500");
  await expect(canViewCosts(shopify.admin, "b.myshopify.com", "1")).rejects.toThrow();
});
