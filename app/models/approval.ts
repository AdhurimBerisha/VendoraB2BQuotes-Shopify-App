import { z } from "zod";
import type { Money } from "../lib/money";

// Pure approval rules: which reasons (if any) make a submitted quote need a manager.

// Shop.approvalRules. Totals are limited per currency so no exchange rates are needed
// (Snowdevil buys in CAD from a USD shop). A currency without a limit always needs approval.
const approvalRulesSchema = z.object({
  maxDiscountPct: z.number().min(0).max(100).nullable(), // null = no discount limit
  maxTotalByCurrency: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().min(0)),
  alwaysRequire: z.boolean(),
  requireDifferentApprover: z.boolean(), // the requester can't approve their own quote
});
type ApprovalRules = z.infer<typeof approvalRulesSchema>;

const DEFAULT_RULES: ApprovalRules = {
  maxDiscountPct: 15,
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
  code: "ALWAYS" | "DISCOUNT_OVER" | "TOTAL_OVER" | "NO_THRESHOLD_FOR_CURRENCY";
  detail?: string;
};

const approvalReasons = (
  totals: { effectiveDiscountPct: Money; total: Money },
  rules: ApprovalRules,
  currency: string,
): ApprovalReason[] => {
  const reasons: ApprovalReason[] = [];
  if (rules.alwaysRequire) reasons.push({ code: "ALWAYS" });
  if (rules.maxDiscountPct !== null && totals.effectiveDiscountPct.gt(rules.maxDiscountPct)) {
    reasons.push({
      code: "DISCOUNT_OVER",
      detail: `${totals.effectiveDiscountPct.toFixed(1)}% > ${rules.maxDiscountPct}%`,
    });
  }
  const maxTotal = rules.maxTotalByCurrency[currency];
  if (maxTotal === undefined) {
    reasons.push({ code: "NO_THRESHOLD_FOR_CURRENCY", detail: currency });
  } else if (totals.total.gt(maxTotal)) {
    reasons.push({ code: "TOTAL_OVER", detail: `${totals.total.toFixed(2)} > ${maxTotal} ${currency}` });
  }
  return reasons;
};

// Empty fields mean "no limit"; currency rows with neither a currency nor an amount are skipped.
const optionalNumber = z.preprocess((value) => (value === "" ? null : value), z.coerce.number().nullable());
const rulesFormSchema = z.object({
  intent: z.literal("saveApprovalRules"),
  maxDiscountPct: optionalNumber,
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
    maxTotalByCurrency,
    alwaysRequire: input.alwaysRequire === "on",
    requireDifferentApprover: input.requireDifferentApprover === "on",
  };
};

export { DEFAULT_RULES, approvalReasons, approvalRulesSchema, parseRules, rulesFromForm };
export type { ApprovalReason, ApprovalRules };
