import { z } from "zod";
import { D, type Money, formatMoney } from "../lib/money";

// Pure approval rules: which reasons (if any) make a submitted quote need a manager.

// Shop.approvalRules. Totals are limited per currency so no exchange rates are needed
// (Snowdevil buys in CAD from a USD shop). A currency without a limit always needs approval.
const approvalRulesSchema = z.object({
  maxDiscountPct: z.number().min(0).max(100).nullable(), // null = no discount limit
  minMarginPct: z.number().min(0).max(100).nullable(), // M10.2; null = no margin rule
  maxTotalByCurrency: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().min(0)),
  alwaysRequire: z.boolean(),
  requireDifferentApprover: z.boolean(), // the requester can't approve their own quote
});
type ApprovalRules = z.infer<typeof approvalRulesSchema>;

const DEFAULT_RULES: ApprovalRules = {
  maxDiscountPct: 15,
  minMarginPct: null,
  maxTotalByCurrency: {},
  alwaysRequire: false,
  requireDifferentApprover: true,
};

// Missing keys fall back to the defaults; invalid stored rules fall back entirely (and say so).
const parseRules = (json: unknown): ApprovalRules => {
  const parsed = approvalRulesSchema.partial().safeParse(json);
  if (!parsed.success) {
    console.warn("invalid approval rules, using defaults", { issues: parsed.error.issues.length });
    return DEFAULT_RULES;
  }
  return { ...DEFAULT_RULES, ...parsed.data };
};

type ApprovalReason = {
  code: "ALWAYS" | "DISCOUNT_OVER" | "MARGIN_UNDER" | "TOTAL_OVER" | "NO_THRESHOLD_FOR_CURRENCY";
  detail?: string;
};

// marginPct: the quote's margin (M10.2), null when unknown (no costs, or a quote in another currency
// than the shop's): the margin rule then doesn't apply.
const approvalReasons = (
  totals: { effectiveDiscountPct: Money; total: Money },
  rules: ApprovalRules,
  currency: string,
  marginPct: Money | null = null,
): ApprovalReason[] => {
  const reasons: ApprovalReason[] = [];
  if (rules.alwaysRequire) reasons.push({ code: "ALWAYS" });
  if (rules.maxDiscountPct !== null && totals.effectiveDiscountPct.gt(rules.maxDiscountPct)) {
    reasons.push({
      code: "DISCOUNT_OVER",
      detail: `${totals.effectiveDiscountPct.toFixed(1)}% > ${rules.maxDiscountPct}%`,
    });
  }
  if (rules.minMarginPct !== null && marginPct !== null && marginPct.lt(rules.minMarginPct)) {
    // The limit only, not the margin itself: reasons are shown to staff who may not see costs.
    reasons.push({ code: "MARGIN_UNDER", detail: `${rules.minMarginPct}%` });
  }
  const maxTotal = rules.maxTotalByCurrency[currency];
  if (maxTotal === undefined) {
    reasons.push({ code: "NO_THRESHOLD_FOR_CURRENCY", detail: currency });
  } else if (totals.total.gt(maxTotal)) {
    // e.g. "$24,881.00 > $10,000.00": shown on the quote page and in the approval email.
    reasons.push({ code: "TOTAL_OVER", detail: `${formatMoney(totals.total, currency)} > ${formatMoney(D(maxTotal), currency)}` });
  }
  return reasons;
};

// Empty fields mean "no limit"; currency rows with neither a currency nor an amount are skipped.
const optionalNumber = z.preprocess((value) => (value === "" ? null : value), z.coerce.number().nullable());
const rulesFormSchema = z.object({
  intent: z.literal("saveApprovalRules"),
  maxDiscountPct: optionalNumber,
  minMarginPct: optionalNumber.optional(), // a form without the field keeps no margin rule
  currency: z.array(z.string()),
  maxTotal: z.array(z.string()),
  alwaysRequire: z.literal("on").optional(),
  requireDifferentApprover: z.literal("on").optional(),
});

// Settings form → rules. Validated again by approvalRulesSchema when saved.
const rulesFromForm = (form: FormData): ApprovalRules => {
  const input = rulesFormSchema.parse({
    ...Object.fromEntries(form),
    currency: form.getAll("currency"),
    maxTotal: form.getAll("maxTotal"),
  });
  const maxTotalByCurrency: Record<string, number> = {};
  input.currency.forEach((currency, index) => {
    const code = currency.trim().toUpperCase();
    const amount = input.maxTotal[index]?.trim() ?? "";
    if (!code && !amount) return;
    maxTotalByCurrency[code] = amount === "" ? Number.NaN : Number(amount); // NaN fails validation
  });
  return {
    maxDiscountPct: input.maxDiscountPct,
    minMarginPct: input.minMarginPct ?? null,
    maxTotalByCurrency,
    alwaysRequire: input.alwaysRequire === "on",
    requireDifferentApprover: input.requireDifferentApprover === "on",
  };
};

export { DEFAULT_RULES, approvalReasons, approvalRulesSchema, parseRules, rulesFromForm };
export type { ApprovalReason, ApprovalRules };
