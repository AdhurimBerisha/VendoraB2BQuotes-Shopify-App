import { expect, test } from "vitest";
import { D } from "../lib/money";
import {
  type ApprovalRules,
  DEFAULT_RULES,
  approvalReasons,
  approvalRulesSchema,
  parseRules,
  rulesFromForm,
} from "./approval";

const rules = (overrides: Partial<ApprovalRules>): ApprovalRules => ({ ...DEFAULT_RULES, ...overrides });
const codes = (
  overrides: Partial<ApprovalRules>,
  discountPct: string,
  total: string,
  currency: string,
) =>
  approvalReasons({ effectiveDiscountPct: D(discountPct), total: D(total) }, rules(overrides), currency).map(
    (reason) => reason.code,
  );

type Case = { name: string; r: Partial<ApprovalRules>; pct: string; total: string; cur: string; expected: string[] };

test.each<Case>([
  { name: "discount over", r: { maxDiscountPct: 15, maxTotalByCurrency: { CAD: 13500 } }, pct: "22.48", total: "1116.25", cur: "CAD", expected: ["DISCOUNT_OVER"] },
  { name: "total over", r: { maxDiscountPct: 25, maxTotalByCurrency: { CAD: 1000 } }, pct: "22.48", total: "1116.25", cur: "CAD", expected: ["TOTAL_OVER"] },
  { name: "no limit for the currency", r: { maxDiscountPct: 25, maxTotalByCurrency: {} }, pct: "10", total: "100", cur: "USD", expected: ["NO_THRESHOLD_FOR_CURRENCY"] },
  { name: "always require", r: { alwaysRequire: true, maxTotalByCurrency: { USD: 1000 } }, pct: "0", total: "1", cur: "USD", expected: ["ALWAYS"] },
  { name: "within every rule", r: { maxDiscountPct: 25, maxTotalByCurrency: { USD: 1000 } }, pct: "10", total: "500", cur: "USD", expected: [] },
  { name: "exactly at the limits is fine", r: { maxDiscountPct: 15, maxTotalByCurrency: { USD: 500 } }, pct: "15", total: "500", cur: "USD", expected: [] },
  { name: "no discount limit", r: { maxDiscountPct: null, maxTotalByCurrency: { USD: 1000 } }, pct: "90", total: "10", cur: "USD", expected: [] },
])("$name", ({ r, pct, total, cur, expected }) => {
  expect(codes(r, pct, total, cur)).toEqual(expected);
});

test("reasons explain themselves", () => {
  const [reason] = approvalReasons(
    { effectiveDiscountPct: D("22.4789"), total: D(10) },
    rules({ maxDiscountPct: 15, maxTotalByCurrency: { USD: 100 } }),
    "USD",
  );
  expect(reason).toEqual({ code: "DISCOUNT_OVER", detail: "22.5% > 15%" });
});

test("total reason shows both amounts as money", () => {
  const [reason] = approvalReasons(
    { effectiveDiscountPct: D(0), total: D("24881") },
    rules({ maxDiscountPct: 15, maxTotalByCurrency: { USD: 10000 } }),
    "USD",
  );
  expect(reason).toEqual({ code: "TOTAL_OVER", detail: "$24,881.00 > $10,000.00" });
});

test("parseRules fills missing keys and survives bad data", () => {
  expect(parseRules({ alwaysRequire: true })).toEqual({ ...DEFAULT_RULES, alwaysRequire: true });
  expect(parseRules(null)).toEqual(DEFAULT_RULES);
  expect(parseRules({ maxDiscountPct: "lots" })).toEqual(DEFAULT_RULES);
});

const settingsForm = (fields: [string, string][]) => {
  const form = new FormData();
  form.set("intent", "saveApprovalRules");
  for (const [key, value] of fields) form.append(key, value);
  return form;
};

test("settings form: limits, the empty add-row, switches", () => {
  const form = settingsForm([
    ["maxDiscountPct", "12.5"],
    ["currency", "usd"], ["maxTotal", "5000"],
    ["currency", "CAD"], ["maxTotal", "6750.50"],
    ["currency", ""], ["maxTotal", ""],
    ["requireDifferentApprover", "on"],
  ]);
  expect(rulesFromForm(form)).toEqual({
    maxDiscountPct: 12.5,
    minMarginPct: null,
    maxTotalByCurrency: { USD: 5000, CAD: 6750.5 },
    alwaysRequire: false,
    requireDifferentApprover: true,
  });
});

test("settings form: empty discount means no limit", () => {
  expect(rulesFromForm(settingsForm([["maxDiscountPct", ""]])).maxDiscountPct).toBeNull();
});

test("settings form: a half-filled currency row is rejected when saved", () => {
  const amountOnly = rulesFromForm(settingsForm([["maxDiscountPct", ""], ["currency", ""], ["maxTotal", "100"]]));
  const currencyOnly = rulesFromForm(settingsForm([["maxDiscountPct", ""], ["currency", "EUR"], ["maxTotal", ""]]));
  expect(approvalRulesSchema.safeParse(amountOnly).success).toBe(false);
  expect(approvalRulesSchema.safeParse(currencyOnly).success).toBe(false);
});

// M10.2
test("margin rule: below the minimum needs approval; unknown margin or no rule doesn't", () => {
  const margin = (minMarginPct: number | null, marginPct: string | null) =>
    approvalReasons(
      { effectiveDiscountPct: D(0), total: D(100) },
      rules({ minMarginPct, maxTotalByCurrency: { USD: 1000 } }),
      "USD",
      marginPct === null ? null : D(marginPct),
    );
  // The detail is the limit, not the margin: reasons are shown to staff who may not see costs.
  expect(margin(20, "15.0")).toEqual([{ code: "MARGIN_UNDER", detail: "20%" }]);
  expect(margin(20, "20.0")).toEqual([]);
  expect(margin(20, "25.0")).toEqual([]);
  expect(margin(20, null)).toEqual([]);
  expect(margin(null, "1.0")).toEqual([]);
});

test("margin rule: stored rules without it parse to off; the settings form reads it", () => {
  expect(parseRules({ maxDiscountPct: 10 }).minMarginPct).toBeNull();
  expect(rulesFromForm(settingsForm([["maxDiscountPct", ""], ["minMarginPct", "22.5"]])).minMarginPct).toBe(22.5);
  expect(rulesFromForm(settingsForm([["maxDiscountPct", ""], ["minMarginPct", ""]])).minMarginPct).toBeNull();
});
