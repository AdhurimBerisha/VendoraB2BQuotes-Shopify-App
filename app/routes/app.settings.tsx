import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import { runAction, type ActionResult } from "../lib/action.server";
import { parseForm } from "../lib/validation";
import { getActor } from "../models/actor.server";
import { type ApprovalRules, parseRules, rulesFromForm } from "../models/approval";
import { saveApprovalRules } from "../models/approval.server";
import { ROLES, requirePermission } from "../models/permissions";
import { getShop } from "../models/shop.server";
import { listStaff, setRole } from "../models/staff.server";

// Settings: Team and Approval rules. Branding (M3.1) and notifications (M3.3) add their own
// sections and intents.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "settings.manage");
  const staff = await listStaff(actor.shop);
  const shop = await getShop(actor.shop);
  return {
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
    if (form.get("intent") === "saveApprovalRules") {
      await saveApprovalRules(actor, rulesFromForm(form));
      return null;
    }
    const { staffId, role } = parseForm(form, setRoleSchema);
    await setRole(actor, staffId, role);
    return null;
  });
};

// ponytail: shows raw translation keys until app/locales arrives in M2.8.
const errorText = (result: ActionResult<unknown> | undefined) =>
  result && !result.ok ? result.error.key : null;

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner",
  MANAGER: "Manager",
  REP: "Sales rep",
  VIEWER: "Viewer",
};

export default function Settings() {
  const { staff, rules } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-section heading="Team">
        <s-paragraph>
          Staff appear here after they open Vendora once. Owners manage settings and roles,
          managers approve quotes, sales reps create and send them, viewers can only look.
        </s-paragraph>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Name</s-table-header>
            <s-table-header>Email</s-table-header>
            <s-table-header>Role</s-table-header>
            <s-table-header>Last seen</s-table-header>
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

function ApprovalRulesSection({ rules }: { rules: ApprovalRules }) {
  const fetcher = useFetcher<typeof action>();
  const error = errorText(fetcher.data);
  // Existing limits plus one empty row to add a currency. Clear both fields to remove one.
  const rows = [...Object.entries(rules.maxTotalByCurrency), ["", ""] as const];

  return (
    <s-section heading="Approval rules">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="saveApprovalRules" />
        <s-stack direction="block" gap="base">
          <s-paragraph>
            A submitted quote needs a manager&apos;s approval when it breaks any of these rules.
            Quotes in a currency without a limit always need approval.
          </s-paragraph>
          <s-number-field
            label="Maximum discount without approval (%)"
            details="Compared with the catalog price total. Leave empty for no limit."
            name="maxDiscountPct"
            value={rules.maxDiscountPct === null ? "" : String(rules.maxDiscountPct)}
            min={0}
            max={100}
            step={0.1}
          ></s-number-field>
          <s-heading>Maximum quote total per currency</s-heading>
          {rows.map(([currency, amount], index) => (
            <s-grid key={`${currency}-${index}`} gridTemplateColumns="1fr 2fr" gap="base">
              <s-text-field
                label="Currency"
                details={index === rows.length - 1 ? "Add a currency, e.g. CAD" : undefined}
                name="currency"
                value={currency}
                maxLength={3}
              ></s-text-field>
              <s-number-field
                label="Maximum total"
                name="maxTotal"
                value={String(amount)}
                min={0}
                step={0.01}
              ></s-number-field>
            </s-grid>
          ))}
          <s-switch
            label="Always require approval"
            name="alwaysRequire"
            value="on"
            checked={rules.alwaysRequire}
          ></s-switch>
          <s-switch
            label="The approver must be a different person than the requester"
            name="requireDifferentApprover"
            value="on"
            checked={rules.requireDifferentApprover}
          ></s-switch>
          <s-button type="submit" variant="primary" {...(fetcher.state !== "idle" ? { loading: true } : {})}>
            Save approval rules
          </s-button>
          {error && <s-banner tone="critical">{error}</s-banner>}
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
  const error = errorText(fetcher.data);

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
              label={`Role for ${member.name}`}
              labelAccessibilityVisibility="exclusive"
              name="role"
              value={member.role}
            >
              {ROLES.map((role) => (
                <s-option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </s-option>
              ))}
            </s-select>
            <s-button type="submit" {...(fetcher.state !== "idle" ? { loading: true } : {})}>
              Save
            </s-button>
          </s-grid>
          {error && <s-text tone="critical">{error}</s-text>}
        </fetcher.Form>
      </s-table-cell>
      <s-table-cell>{member.lastSeen}</s-table-cell>
    </s-table-row>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
