import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import ErrorBanner from "../components/ErrorBanner";
import { runAction } from "../lib/action.server";
import { parseForm } from "../lib/validation";
import { getActor } from "../models/actor.server";
import { type ApprovalRules, parseRules, rulesFromForm } from "../models/approval";
import { saveApprovalRules } from "../models/approval.server";
import { ROLES, requirePermission } from "../models/permissions";
import { generalSettingsFromForm, getShop, saveGeneralSettings } from "../models/shop.server";
import { listStaff, setRole } from "../models/staff.server";

// Settings: General, Team and Approval rules. Branding (M3.1) and notifications (M3.3) add their own
// sections and intents.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "settings.manage");
  const staff = await listStaff(actor.shop);
  const shop = await getShop(actor.shop);
  return {
    general: {
      quotePrefix: shop?.quotePrefix ?? "Q-",
      nextQuoteNumber: shop?.nextQuoteNumber ?? 1001,
      defaultExpiryDays: shop?.defaultExpiryDays ?? 30,
      reserveInventory: shop?.reserveInventory ?? false,
      notifyEmails: shop?.notifyEmails.join(", ") ?? "",
    },
    rules: parseRules(shop?.approvalRules),
    staff: staff.map((member) => ({
      id: member.id,
      name: member.displayName,
      email: member.email,
      role: member.role,
      lastSeen: member.lastSeenAt.toISOString().slice(0, 10),
    })),
  };
};

const setRoleSchema = z.object({
  intent: z.literal("setRole"),
  staffId: z.string().min(1),
  role: z.enum(["OWNER", "MANAGER", "REP", "VIEWER"]),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const actor = await getActor(request);
  const form = await request.formData();
  return runAction(async () => {
    const intent = form.get("intent");
    if (intent === "saveGeneral") {
      await saveGeneralSettings(actor, generalSettingsFromForm(form));
      return null;
    }
    if (intent === "saveApprovalRules") {
      await saveApprovalRules(actor, rulesFromForm(form));
      return null;
    }
    const { staffId, role } = parseForm(form, setRoleSchema);
    await setRole(actor, staffId, role);
    return null;
  });
};

type LoaderData = ReturnType<typeof useLoaderData<typeof loader>>;

export default function Settings() {
  const { general, staff, rules } = useLoaderData<typeof loader>();
  const { t } = useTranslation();

  return (
    <s-page heading={t("settings.title")}>
      <GeneralSection general={general} />
      <s-section heading={t("settings.team.title")}>
        <s-paragraph>{t("settings.team.help")}</s-paragraph>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("settings.team.name")}</s-table-header>
            <s-table-header>{t("settings.team.email")}</s-table-header>
            <s-table-header>{t("settings.team.role")}</s-table-header>
            <s-table-header>{t("settings.team.lastSeen")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {staff.map((member) => (
              <StaffRow key={member.id} member={member} />
            ))}
          </s-table-body>
        </s-table>
      </s-section>
      <ApprovalRulesSection rules={rules} />
    </s-page>
  );
}

function GeneralSection({ general }: { general: LoaderData["general"] }) {
  const fetcher = useFetcher<typeof action>();
  const { t } = useTranslation();
  return (
    <s-section heading={t("settings.general.title")}>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="saveGeneral" />
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-text-field
              label={t("settings.general.prefix")}
              details={t("settings.general.prefixHelp")}
              name="quotePrefix"
              value={general.quotePrefix}
              maxLength={8}
              required
            ></s-text-field>
            <s-number-field
              label={t("settings.general.nextNumber")}
              details={t("settings.general.nextNumberHelp")}
              name="nextQuoteNumber"
              value={String(general.nextQuoteNumber)}
              min={general.nextQuoteNumber}
              step={1}
              required
            ></s-number-field>
          </s-grid>
          <s-number-field
            label={t("settings.general.expiryDays")}
            name="defaultExpiryDays"
            value={String(general.defaultExpiryDays)}
            min={1}
            max={365}
            step={1}
            required
          ></s-number-field>
          <s-switch
            label={t("settings.general.reserveInventory")}
            details={t("settings.general.reserveInventoryHelp")}
            name="reserveInventory"
            value="on"
            checked={general.reserveInventory}
          ></s-switch>
          <s-text-field
            label={t("settings.general.notifyEmails")}
            details={t("settings.general.notifyEmailsHelp")}
            name="notifyEmails"
            value={general.notifyEmails}
          ></s-text-field>
          <s-button type="submit" variant="primary" {...(fetcher.state !== "idle" ? { loading: true } : {})}>
            {t("settings.general.save")}
          </s-button>
          <ErrorBanner result={fetcher.data} />
        </s-stack>
      </fetcher.Form>
    </s-section>
  );
}

function ApprovalRulesSection({ rules }: { rules: ApprovalRules }) {
  const fetcher = useFetcher<typeof action>();
  const { t } = useTranslation();
  // Existing limits plus one empty row to add a currency. Clear both fields to remove one.
  const rows = [...Object.entries(rules.maxTotalByCurrency), ["", ""] as const];

  return (
    <s-section heading={t("settings.approvals.title")}>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="saveApprovalRules" />
        <s-stack direction="block" gap="base">
          <s-paragraph>{t("settings.approvals.help")}</s-paragraph>
          <s-number-field
            label={t("settings.approvals.maxDiscount")}
            details={t("settings.approvals.maxDiscountHelp")}
            name="maxDiscountPct"
            value={rules.maxDiscountPct === null ? "" : String(rules.maxDiscountPct)}
            min={0}
            max={100}
            step={0.1}
          ></s-number-field>
          <s-heading>{t("settings.approvals.maxTotalTitle")}</s-heading>
          {rows.map(([currency, amount], index) => (
            <s-grid key={`${currency}-${index}`} gridTemplateColumns="1fr 2fr" gap="base">
              <s-text-field
                label={t("settings.approvals.currency")}
                details={index === rows.length - 1 ? t("settings.approvals.currencyHelp") : undefined}
                name="currency"
                value={currency}
                maxLength={3}
              ></s-text-field>
              <s-number-field
                label={t("settings.approvals.maxTotal")}
                name="maxTotal"
                value={String(amount)}
                min={0}
                step={0.01}
              ></s-number-field>
            </s-grid>
          ))}
          <s-switch
            label={t("settings.approvals.alwaysRequire")}
            name="alwaysRequire"
            value="on"
            checked={rules.alwaysRequire}
          ></s-switch>
          <s-switch
            label={t("settings.approvals.differentApprover")}
            name="requireDifferentApprover"
            value="on"
            checked={rules.requireDifferentApprover}
          ></s-switch>
          <s-button type="submit" variant="primary" {...(fetcher.state !== "idle" ? { loading: true } : {})}>
            {t("settings.approvals.save")}
          </s-button>
          <ErrorBanner result={fetcher.data} />
        </s-stack>
      </fetcher.Form>
    </s-section>
  );
}

function StaffRow({
  member,
}: {
  member: { id: string; name: string; email: string | null; role: string; lastSeen: string };
}) {
  const fetcher = useFetcher<typeof action>();
  const { t } = useTranslation();

  return (
    <s-table-row>
      <s-table-cell>{member.name}</s-table-cell>
      <s-table-cell>{member.email ?? "—"}</s-table-cell>
      <s-table-cell>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="setRole" />
          <input type="hidden" name="staffId" value={member.id} />
          <s-grid gridTemplateColumns="1fr auto" gap="small-200" alignItems="end">
            <s-select
              label={t("settings.team.roleFor", { name: member.name })}
              labelAccessibilityVisibility="exclusive"
              name="role"
              value={member.role}
            >
              {ROLES.map((role) => (
                <s-option key={role} value={role}>
                  {t(`roles.${role}`)}
                </s-option>
              ))}
            </s-select>
            <s-button type="submit" {...(fetcher.state !== "idle" ? { loading: true } : {})}>
              {t("common.save")}
            </s-button>
          </s-grid>
          <ErrorBanner result={fetcher.data} />
        </fetcher.Form>
      </s-table-cell>
      <s-table-cell>{member.lastSeen}</s-table-cell>
    </s-table-row>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
