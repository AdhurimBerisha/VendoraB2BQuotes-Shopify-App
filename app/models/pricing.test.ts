import { expect, test } from "vitest";
import { D } from "../lib/money";
import { type PricedLine, lineTotal, quantityProblems, totals, unitPrice } from "./pricing";

const breaks = [
  { minimumQuantity: 10, price: D("45.00") },
  { minimumQuantity: 20, price: D("40.00") },
];
const lineA: PricedLine = { quantity: 3, catalogPrice: D("100.00"), discountPct: D(10) };
const lineB: PricedLine = { quantity: 20, catalogPrice: D("50.00"), priceBreaks: breaks };
const lineC: PricedLine = {
  quantity: 7,
  catalogPrice: D("19.99"),
  overridePrice: D("15.00"),
  priceBreaks: [{ minimumQuantity: 5, price: D("18.00") }],
};

test("line discount: 3 × 100.00 − 10 % = 270.00", () => {
  expect(lineTotal(lineA, "USD").toFixed(2)).toBe("270.00");
});

test("price breaks: the highest reached break wins", () => {
  expect(unitPrice(lineB).toFixed(2)).toBe("40.00");
  expect(lineTotal(lineB, "USD").toFixed(2)).toBe("800.00");
  expect(unitPrice({ ...lineB, quantity: 9 }).toFixed(2)).toBe("50.00");
  expect(unitPrice({ ...lineB, quantity: 10 }).toFixed(2)).toBe("45.00");
});

test("an override beats price breaks", () => {
  expect(lineTotal(lineC, "USD").toFixed(2)).toBe("105.00");
});

test("quote totals with a 5 % quote discount", () => {
  const result = totals([lineA, lineB, lineC], D(5), "USD");
  expect(result.listTotal.toFixed(2)).toBe("1439.93");
  expect(result.subtotal.toFixed(2)).toBe("1175.00");
  expect(result.quoteDiscount.toFixed(2)).toBe("58.75");
  expect(result.total.toFixed(2)).toBe("1116.25");
  expect(result.discountTotal.toFixed(2)).toBe("323.68");
  expect(result.effectiveDiscountPct.toFixed(4)).toBe("22.4789");
});

test("rounding follows the currency: JPY 0 decimals, KWD 3", () => {
  expect(lineTotal({ quantity: 1, catalogPrice: D(333), discountPct: D(10) }, "JPY").toString()).toBe("300");
  expect(lineTotal({ quantity: 1, catalogPrice: D("1.2345") }, "KWD").toString()).toBe("1.235");
});

test("0 % and 100 % discounts", () => {
  const line: PricedLine = { quantity: 2, catalogPrice: D(10) };
  expect(lineTotal({ ...line, discountPct: D(0) }, "USD").toFixed(2)).toBe("20.00");
  expect(lineTotal({ ...line, discountPct: D(100) }, "USD").toFixed(2)).toBe("0.00");
});

test("an empty quote is all zero", () => {
  const result = totals([], null, "USD");
  for (const value of Object.values(result)) expect(value.isZero()).toBe(true);
});

test("quantity rules", () => {
  const rule = { minimum: 5, maximum: 100, increment: 5 };
  expect(quantityProblems(3, rule)).toEqual(["QTY_BELOW_MIN"]);
  expect(quantityProblems(7, rule)).toEqual(["QTY_NOT_INCREMENT"]);
  expect(quantityProblems(105, rule)).toEqual(["QTY_ABOVE_MAX"]);
  expect(quantityProblems(10, rule)).toEqual([]);
  expect(quantityProblems(9999, { minimum: 1, maximum: null, increment: 1 })).toEqual([]);
});
