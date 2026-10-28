import { expect, test } from "vitest";
import { D, roundMoney, toShopifyAmount } from "./money";

test("rounds half up to each currency's minor units", () => {
  expect(roundMoney(D("1.005"), "USD").toString()).toBe("1.01");
  expect(roundMoney(D("100.5"), "JPY").toString()).toBe("101");
  expect(roundMoney(D("1.0005"), "KWD").toString()).toBe("1.001");
});

test("Shopify amounts always carry the currency's decimals", () => {
  expect(toShopifyAmount(D("10"), "USD")).toBe("10.00");
  expect(toShopifyAmount(D("10"), "JPY")).toBe("10");
});
