import { expect, test } from "vitest";
import { D } from "../lib/money";
import { type PricedLine, lineTotal, marginOf, quantityProblems, totals, unitPrice } from "./pricing";

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

// B-33: the same numbers Shopify's draftOrderCalculate gave on 2026-11-21 (dev store, CAD).
test("discounts round down and unit prices round first, like the draft order", () => {
  // 5 % of 2848.95 = 142.4475 → Shopify −142.44, total 2706.51 (Q-1019)
  const q1019 = totals(
    [
      { quantity: 1, catalogPrice: D(1314) },
      { quantity: 2, catalogPrice: D(830), discountPct: D(10) },
      { quantity: 1, catalogPrice: D("45.50"), discountPct: D(10) },
    ],
    D(5),
    "CAD",
  );
  expect([q1019.subtotal.toFixed(2), q1019.quoteDiscount.toFixed(2), q1019.total.toFixed(2)]).toEqual([
    "2848.95",
    "142.44",
    "2706.51",
  ]);
  // 10 % of 3 × 12.35 = 3.705 → 3.70 off, line 33.35
  expect(lineTotal({ quantity: 3, catalogPrice: D("12.35"), discountPct: D(10) }, "CAD").toFixed(2)).toBe("33.35");
  // 5 % of 0.30 = 0.015 → 0.01 off
  expect(lineTotal({ quantity: 1, catalogPrice: D("0.30"), discountPct: D(5) }, "CAD").toFixed(2)).toBe("0.29");
  // An override with 4 decimals goes to Shopify as 1.23 per unit: 10 × 1.23, not 12.345 → 12.35
  expect(lineTotal({ quantity: 10, catalogPrice: D(2), overridePrice: D("1.2345") }, "CAD").toFixed(2)).toBe("12.30");
});


// M10.2: two lines, 100 × 1 at cost 60 and 50 × 2 at cost 20 → revenue 200, cost 100.
const costed = [
  { lineTotal: D(100), quantity: 1, unitCost: D(60) },
  { lineTotal: D(100), quantity: 2, unitCost: D(20) },
];

test("margin: (revenue − cost) / revenue", () => {
  const margin = marginOf(costed, D(200), D(200));
  expect(margin.revenue.toString()).toBe("200");
  expect(margin.cost.toString()).toBe("100");
  expect(margin.marginPct?.toString()).toBe("50");
});

test("margin: the quote discount lowers revenue (10 %: 180 − 100 = 44.4 %)", () => {
  const margin = marginOf(costed, D(200), D(180));
  expect(margin.revenue.toString()).toBe("180");
  expect(margin.marginPct?.toString()).toBe("44.4");
});

test("margin: lines without a cost don't count", () => {
  const margin = marginOf([...costed, { lineTotal: D(500), quantity: 1, unitCost: null }], D(700), D(700));
  expect(margin.marginPct?.toString()).toBe("50");
  expect(margin).toMatchObject({ linesWithCost: 2, lines: 3 });
});

test("margin: none without costs or revenue", () => {
  expect(marginOf([{ lineTotal: D(100), quantity: 1, unitCost: null }], D(100), D(100)).marginPct).toBeNull();
  expect(marginOf([{ lineTotal: D(0), quantity: 1, unitCost: D(5) }], D(0), D(0)).marginPct).toBeNull();
  expect(marginOf([], D(0), D(0)).marginPct).toBeNull();
});

test("margin: selling below cost is negative", () => {
  expect(marginOf([{ lineTotal: D(80), quantity: 1, unitCost: D(100) }], D(80), D(80)).marginPct?.toString()).toBe("-25");
});
