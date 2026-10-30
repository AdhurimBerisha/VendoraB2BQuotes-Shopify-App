import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import { runAction, type ActionResult } from "../lib/action.server";
import { parseForm } from "../lib/validation";
import { getActor } from "../models/actor.server";
import { ROLES, requirePermission } from "../models/permissions";
import { listStaff, setRole } from "../models/staff.server";

// Settings. Only the Team section for now; approval rules (M2.5), branding (M3.1)
// and notifications (M3.3) add their own sections and intents.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "settings.manage");
  const staff = await listStaff(actor.shop);
  return {
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
  const { staff } = useLoaderData<typeof loader>();

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
    </s-page>
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
