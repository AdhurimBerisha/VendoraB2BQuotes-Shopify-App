import { D, type Money, ZERO, roundMoney, roundMoneyDown, sum } from "../lib/money";

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

// Line total after the line discount, computed the way the draft order is (B-33): Shopify gets the
// unit price rounded to the currency, and rounds a percentage discount on the line total down.
const lineTotal = (line: PricedLine, currency: string): Money => {
  const gross = roundMoney(unitPrice(line), currency).mul(line.quantity);
  const discount = line.discountPct ? roundMoneyDown(gross.mul(line.discountPct).div(100), currency) : ZERO;
  return gross.minus(discount);
};

// discountTotal / listTotal × 100, 4 decimals; 0 for an empty quote.
const discountPctOf = (listTotal: Money, discountTotal: Money): Money =>
  listTotal.isZero() ? ZERO : discountTotal.div(listTotal).mul(100).toDecimalPlaces(4);

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
  // Rounded down like Shopify's percentage discount on the draft order (B-33).
  const quoteDiscount = quoteDiscountPct
    ? roundMoneyDown(subtotal.mul(quoteDiscountPct).div(100), currency)
    : ZERO;
  const total = subtotal.minus(quoteDiscount);
  const discountTotal = listTotal.minus(total);
  const effectiveDiscountPct = discountPctOf(listTotal, discountTotal);
  return { listTotal, subtotal, quoteDiscount, total, discountTotal, effectiveDiscountPct };
};

// M10.2 margin. Lines without a cost don't count (unknown is not zero). The quote discount is
// spread over the lines in proportion to their totals.
type MarginLine = { lineTotal: Money; quantity: number; unitCost: Money | null };
type Margin = {
  revenue: Money; // over lines with a cost, after the quote discount
  cost: Money;
  marginPct: Money | null; // 1 decimal; null when no line has a cost or revenue is 0
  linesWithCost: number;
  lines: number;
};

const marginOf = (lines: MarginLine[], subtotal: Money, total: Money): Margin => {
  const share = subtotal.isZero() ? D(1) : total.div(subtotal);
  let revenue = ZERO;
  let cost = ZERO;
  let linesWithCost = 0;
  for (const line of lines) {
    if (line.unitCost === null) continue;
    revenue = revenue.plus(line.lineTotal.mul(share));
    cost = cost.plus(line.unitCost.mul(line.quantity));
    linesWithCost += 1;
  }
  const marginPct =
    linesWithCost === 0 || revenue.isZero() ? null : revenue.minus(cost).div(revenue).mul(100).toDecimalPlaces(1);
  return { revenue, cost, marginPct, linesWithCost, lines: lines.length };
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

// Identifies a line across versions and draft orders: its variant, or custom:<title> (M9.2).
// The title is encoded so linesKey's ":" and "|" separators stay unambiguous.
const lineKey = (variantId: string | null, title: string) => variantId ?? `custom:${encodeURIComponent(title)}`;

// Order-independent fingerprint of line × quantity (draft order ↔ quote comparison).
const linesKey = (lines: { variantId: string | null; title: string; quantity: number }[]) =>
  lines
    .map((line) => `${lineKey(line.variantId, line.title)}:${line.quantity}`)
    .sort()
    .join("|");

export { BLOCKING, discountPctOf, lineKey, lineTotal, linesKey, marginOf, quantityProblems, totals, unitPrice };
export type { LineProblem, Margin, MarginLine, PriceBreak, PricedLine, QuantityRule, Totals };
