import { type Money, ZERO, roundMoney, sum } from "../lib/money";

// Pure price math, no server imports, so pages can use it too (M2.8 live totals).

type QuantityRule = { minimum: number; maximum: number | null; increment: number };
type PriceBreak = { minimumQuantity: number; price: Money };
type PricedLine = {
  quantity: number;
  catalogPrice: Money;
  overridePrice?: Money | null;
  discountPct?: Money | null;
  priceBreaks?: PriceBreak[];
};

// Unit price before the line discount: override > best reached price break > catalog price.
const unitPrice = (line: PricedLine): Money => {
  if (line.overridePrice) return line.overridePrice;
  let best: PriceBreak | undefined;
  for (const priceBreak of line.priceBreaks ?? []) {
    if (line.quantity < priceBreak.minimumQuantity) continue;
    if (!best || priceBreak.minimumQuantity > best.minimumQuantity) best = priceBreak;
  }
  return best ? best.price : line.catalogPrice;
};

// Line total after the line discount, rounded to the currency.
const lineTotal = (line: PricedLine, currency: string): Money => {
  const gross = unitPrice(line).mul(line.quantity);
  const discount = line.discountPct ? gross.mul(line.discountPct).div(100) : ZERO;
  return roundMoney(gross.minus(discount), currency);
};

type Totals = {
  listTotal: Money; // catalog price × quantity: the cost without any deal
  subtotal: Money; // after line prices and line discounts
  quoteDiscount: Money; // the quote-level discount amount
  total: Money; // subtotal − quoteDiscount (before tax and shipping)
  discountTotal: Money; // listTotal − total
  effectiveDiscountPct: Money; // discountTotal / listTotal × 100 (approval rules, M2.5)
};

const totals = (
  lines: PricedLine[],
  quoteDiscountPct: Money | null | undefined,
  currency: string,
): Totals => {
  const listTotal = sum(lines.map((line) => roundMoney(line.catalogPrice.mul(line.quantity), currency)));
  const subtotal = sum(lines.map((line) => lineTotal(line, currency)));
  const quoteDiscount = quoteDiscountPct
    ? roundMoney(subtotal.mul(quoteDiscountPct).div(100), currency)
    : ZERO;
  const total = subtotal.minus(quoteDiscount);
  const discountTotal = listTotal.minus(total);
  const effectiveDiscountPct = listTotal.isZero()
    ? ZERO
    : discountTotal.div(listTotal).mul(100).toDecimalPlaces(4);
  return { listTotal, subtotal, quoteDiscount, total, discountTotal, effectiveDiscountPct };
};

type LineProblem =
  | "QTY_BELOW_MIN"
  | "QTY_ABOVE_MAX"
  | "QTY_NOT_INCREMENT"
  | "OUT_OF_STOCK"
  | "PRODUCT_NOT_ACTIVE"
  | "GIFT_CARD"
  | "CURRENCY_MISMATCH"
  | "PRODUCT_DELETED";

const quantityProblems = (quantity: number, rule: QuantityRule | null | undefined): LineProblem[] => {
  if (!rule) return [];
  const problems: LineProblem[] = [];
  // Below the minimum, steps don't matter yet: one clear problem is enough.
  if (quantity < rule.minimum) return ["QTY_BELOW_MIN"];
  if (rule.maximum !== null && quantity > rule.maximum) problems.push("QTY_ABOVE_MAX");
  if (rule.increment > 1 && (quantity - rule.minimum) % rule.increment !== 0) {
    problems.push("QTY_NOT_INCREMENT");
  }
  return problems;
};

// Problems that block sending; the rest (OUT_OF_STOCK) are warnings.
const BLOCKING: LineProblem[] = [
  "QTY_BELOW_MIN",
  "QTY_ABOVE_MAX",
  "QTY_NOT_INCREMENT",
  "PRODUCT_NOT_ACTIVE",
  "GIFT_CARD",
  "CURRENCY_MISMATCH",
  "PRODUCT_DELETED",
];

export { BLOCKING, lineTotal, quantityProblems, totals, unitPrice };
export type { LineProblem, PriceBreak, PricedLine, QuantityRule, Totals };
