import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import ErrorBanner from "../components/ErrorBanner";
import { runAction } from "../lib/action.server";
import { UserError } from "../lib/errors";
import { getActor } from "../models/actor.server";
import { parseRules, rulesFromForm } from "../models/approval";
import { saveApprovalRules } from "../models/approval.server";
import { STEPS, advance, connectionTest, finishOnboarding, runEligibility } from "../models/onboarding.server";
import { ROLES, requirePermission } from "../models/permissions";
import { getShop } from "../models/shop.server";

// M5.2 setup wizard: one step per page load, kept in Shop.onboardingStep. Owners only.

// Suggested approval limit in the shop's currency. Without any limit every quote needs approval (G-15).
const SUGGESTED_MAX_TOTAL = 10_000;

const FIX_LINKS: Record<string, { href: string; target: "_top" | "_blank" } | undefined> = {
  b2b: { href: "https://help.shopify.com/manual/b2b", target: "_blank" },
  company: { href: "shopify://admin/companies", target: "_top" },
  mainContact: { href: "shopify://admin/companies", target: "_top" },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "settings.manage");
  const shop = await getShop(actor.shop);
  // No row yet = the very first load after install (app.tsx is creating it right now).
  const step = shop?.onboardingStep ?? "WELCOME";
  // Keep the query string: on a full page load it carries what Shopify auth needs (shop, host).
  if (step === "DONE") throw redirect(`/app${new URL(request.url).search}`);

  const rules = parseRules(shop?.approvalRules);
  const currency = shop?.currencyCode ?? "USD";
  return {
    step,
    progress: { current: STEPS.findIndex((candidate) => candidate === step) + 1, total: STEPS.length - 1 },
    checks: step === "ELIGIBILITY" ? await runEligibility(actor.admin, actor.session.scope) : [],
    currency,
    rules: {
      maxDiscountPct: rules.maxDiscountPct,
      requireDifferentApprover: rules.requireDifferentApprover,
      alwaysRequire: rules.alwaysRequire,
      maxTotal: rules.maxTotalByCurrency[currency] ?? SUGGESTED_MAX_TOTAL,
      otherLimits: Object.entries(rules.maxTotalByCurrency).filter(([code]) => code !== currency),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const actor = await getActor(request);
  const form = await request.formData();
  return runAction(async () => {
    const intent = form.get("intent");
    if (intent === "next") {
      await advance(actor, String(form.get("from")), actor.session.scope);
      return null;
    }
    if (intent === "saveApprovalRules") {
      await saveApprovalRules(actor, rulesFromForm(form));
      await advance(actor, "SETTINGS", actor.session.scope);
      return null;
    }
    if (intent === "connection") return connectionTest(actor);
    if (intent === "finish") {
      await finishOnboarding(actor);
      throw redirect(form.get("then") === "quote" ? "/app/quotes/new" : "/app");
    }
    throw new UserError("errors.invalidInput", { fields: "intent" });
  });
};

export default function Onboarding() {
  const { step, progress, checks, currency, rules } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const loading = fetcher.state !== "idle" ? { loading: true } : {};
  const connection = fetcher.data?.ok ? fetcher.data.data : null;
  const blocked = checks.some((check) => !check.ok);

  const continueButton = (disabled = false) => (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="next" />
      <input type="hidden" name="from" value={step} />
      <s-button type="submit" variant="primary" disabled={disabled} {...loading}>
        {t("onboarding.continue")}
      </s-button>
    </fetcher.Form>
  );

  return (
    <s-page heading={t("onboarding.title")}>
      <s-section heading={t(`onboarding.steps.${step}.title`)}>
        <s-stack direction="block" gap="base">
          <s-text color="subdued">{t("onboarding.progress", progress)}</s-text>
          <s-paragraph>{t(`onboarding.steps.${step}.intro`)}</s-paragraph>

          {step === "WELCOME" && (
            <>
              <s-unordered-list>
                <s-list-item>{t("onboarding.welcome.draftOrders")}</s-list-item>
                <s-list-item>{t("onboarding.welcome.emails")}</s-list-item>
                <s-list-item>{t("onboarding.welcome.customerPage")}</s-list-item>
              </s-unordered-list>
              {continueButton()}
            </>
          )}

          {step === "ELIGIBILITY" && (
            <>
              {checks.map((check) => {
                const fix = check.ok ? undefined : FIX_LINKS[check.key];
                return (
                  <s-stack key={check.key} direction="inline" gap="small-200" alignItems="center">
                    <s-badge tone={check.ok ? "success" : "critical"}>
                      {check.ok ? t("onboarding.checks.ok") : t("onboarding.checks.failed")}
                    </s-badge>
                    <s-text>{t(`onboarding.checks.${check.key}.${check.ok ? "pass" : "fail"}`)}</s-text>
                    {fix && (
                      <s-link href={fix.href} target={fix.target}>
                        {t("onboarding.checks.fix")}
                      </s-link>
                    )}
                  </s-stack>
                );
              })}
              <s-stack direction="inline" gap="base">
                {continueButton(blocked)}
                <s-button
                  onClick={() => revalidator.revalidate()}
                  {...(revalidator.state !== "idle" ? { loading: true } : {})}
                >
                  {t("onboarding.checks.recheck")}
                </s-button>
              </s-stack>
            </>
          )}

          {step === "SETTINGS" && (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="saveApprovalRules" />
              <input type="hidden" name="currency" value={currency} />
              {rules.alwaysRequire && <input type="hidden" name="alwaysRequire" value="on" />}
              <s-stack direction="block" gap="base">
                <s-number-field
                  label={t("onboarding.settings.maxTotal", { currency })}
                  details={t("onboarding.settings.maxTotalHelp")}
                  name="maxTotal"
                  value={String(rules.maxTotal)}
                  min={0}
                  step={0.01}
                ></s-number-field>
                {/* Limits in other currencies are kept as they are. */}
                {rules.otherLimits.map(([code, amount]) => (
                  <span key={code}>
                    <input type="hidden" name="currency" value={code} />
                    <input type="hidden" name="maxTotal" value={amount} />
                  </span>
                ))}
                <s-number-field
                  label={t("settings.approvals.maxDiscount")}
                  details={t("settings.approvals.maxDiscountHelp")}
                  name="maxDiscountPct"
                  value={rules.maxDiscountPct === null ? "" : String(rules.maxDiscountPct)}
                  min={0}
                  max={100}
                  step={0.1}
                ></s-number-field>
                <s-switch
                  label={t("settings.approvals.differentApprover")}
                  details={t("onboarding.settings.differentApproverHelp")}
                  name="requireDifferentApprover"
                  value="on"
                  checked={rules.requireDifferentApprover}
                ></s-switch>
                <s-button type="submit" variant="primary" {...loading}>
                  {t("onboarding.settings.save")}
                </s-button>
              </s-stack>
            </fetcher.Form>
          )}

          {step === "TEAM" && (
            <>
              <s-unordered-list>
                {ROLES.map((role) => (
                  <s-list-item key={role}>
                    <s-text type="strong">{t(`roles.${role}`)}</s-text>
                    {": "}
                    {t(`onboarding.team.${role}`)}
                  </s-list-item>
                ))}
              </s-unordered-list>
              {continueButton()}
            </>
          )}

          {step === "CONNECTION" && (
            <>
              {connection?.passed === true && <s-banner tone="success">{t("onboarding.connection.passed")}</s-banner>}
              {connection?.passed === false && (
                <s-banner tone="critical">{t("onboarding.connection.failed", { message: connection.message })}</s-banner>
              )}
              <s-stack direction="inline" gap="base">
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="connection" />
                  <s-button type="submit" variant={connection?.passed ? "secondary" : "primary"} {...loading}>
                    {t("onboarding.connection.run")}
                  </s-button>
                </fetcher.Form>
                {connection?.passed && continueButton()}
              </s-stack>
            </>
          )}

          {step === "SAMPLE" && (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="finish" />
              <input type="hidden" name="then" value="quote" />
              <s-button type="submit" variant="primary" {...loading}>
                {t("onboarding.sample.create")}
              </s-button>
            </fetcher.Form>
          )}

          <ErrorBanner result={fetcher.data} />
        </s-stack>
      </s-section>

      <s-section>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="finish" />
          <s-button type="submit" variant="tertiary">
            {t("onboarding.skip")}
          </s-button>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
