import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { describe, expect, test } from "vitest";
import { ForbiddenError } from "../lib/errors";
import { staff } from "../test/factories";
import type { Role } from "./actor";
import { MATRIX, ROLES, type Permission, can, requireCancel, requirePermission } from "./permissions";

const admin = {} as AdminApiContext;
const SHOP = "perm-test.myshopify.com";

// D-9 written out by hand: a change to MATRIX must be a deliberate change here too.
const EXPECTED: Record<Permission, Role[]> = {
  "quote.view": ["OWNER", "MANAGER", "REP", "VIEWER"],
  "quote.create": ["OWNER", "MANAGER", "REP"],
  "quote.edit": ["OWNER", "MANAGER", "REP"],
  "quote.submit": ["OWNER", "MANAGER", "REP"],
  "quote.send": ["OWNER", "MANAGER", "REP"],
  "quote.cancel.own": ["OWNER", "MANAGER", "REP"],
  "import.run": ["OWNER", "MANAGER", "REP"],
  "quote.approve": ["OWNER", "MANAGER"],
  "quote.cancel.any": ["OWNER", "MANAGER"],
  "quote.assign": ["OWNER", "MANAGER"],
  "attention.resolve": ["OWNER", "MANAGER"],
  "jobs.retry": ["OWNER", "MANAGER"],
  "export.all": ["OWNER", "MANAGER"],
  "settings.manage": ["OWNER"],
  "team.manage": ["OWNER"],
};

const cases = ROLES.flatMap((role) =>
  (Object.keys(EXPECTED) as Permission[]).map((permission) => ({
    role,
    permission,
    allowed: EXPECTED[permission].includes(role),
  })),
);

describe("permission matrix", () => {
  test.each(cases)("$role $permission → $allowed", ({ role, permission, allowed }) => {
    expect(can(staff(SHOP, admin, role), permission)).toBe(allowed);
  });

  test("MATRIX has no permissions the expected table doesn't know", () => {
    for (const role of ROLES) {
      for (const permission of MATRIX[role]) expect(EXPECTED).toHaveProperty([permission]);
    }
  });
});

test("jobs and webhooks may do everything, customers nothing here", () => {
  expect(can({ type: "SYSTEM", shop: SHOP, reason: "job" }, "team.manage")).toBe(true);
  expect(can({ type: "WEBHOOK", shop: SHOP, reason: "hook" }, "quote.edit")).toBe(true);
  expect(can({ type: "CUSTOMER", shop: SHOP, customerId: "gid://shopify/Customer/1" }, "quote.view")).toBe(false);
});

test("requirePermission throws ForbiddenError", () => {
  expect(() => requirePermission(staff(SHOP, admin, "VIEWER"), "quote.create")).toThrow(ForbiddenError);
  expect(() => requirePermission(staff(SHOP, admin, "REP"), "quote.create")).not.toThrow();
});

describe("requireCancel", () => {
  const rep = staff(SHOP, admin, "REP", 7n);

  test("a rep cancels their own quote", () => {
    expect(() => requireCancel(rep, { assignedToUserId: 7n })).not.toThrow();
  });

  test("a rep can't cancel someone else's or an unassigned quote", () => {
    expect(() => requireCancel(rep, { assignedToUserId: 8n })).toThrow(ForbiddenError);
    expect(() => requireCancel(rep, { assignedToUserId: null })).toThrow(ForbiddenError);
  });

  test("a manager cancels any quote", () => {
    expect(() => requireCancel(staff(SHOP, admin, "MANAGER", 9n), { assignedToUserId: 7n })).not.toThrow();
  });

  test("a viewer can't cancel even a quote assigned to them", () => {
    expect(() => requireCancel(staff(SHOP, admin, "VIEWER", 7n), { assignedToUserId: 7n })).toThrow(
      ForbiddenError,
    );
  });
});
