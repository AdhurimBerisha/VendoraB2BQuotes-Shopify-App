import { expect, test } from "vitest";
import { type NextActionInput, nextAction } from "./next-action";

const NOW = new Date("2026-11-28T15:00:00Z"); // 10:00 in New York
const TZ = "America/New_York";
const quote = (overrides: Partial<NextActionInput>): NextActionInput => ({
  status: "SENT",
  attention: null,
  expiresAt: null,
  lastSentAt: new Date("2026-11-20T12:00:00Z"),
  lastViewedAt: null,
  approvalRequestedBy: null,
  ...overrides,
});
const approver = { userId: 2n, canApprove: true, requireDifferentApprover: true };
const rep = { userId: 1n, canApprove: false, requireDifferentApprover: true };
const next = (overrides: Partial<NextActionInput>, viewer = rep) => nextAction(quote(overrides), viewer, TZ, NOW);

test("attention beats everything", () => {
  expect(next({ status: "PENDING_APPROVAL", attention: [{ code: "SYNC_FAILED", at: "" }] }, approver)).toEqual({
    code: "attention",
  });
});

test("approval: whose turn it is", () => {
  expect(next({ status: "PENDING_APPROVAL", approvalRequestedBy: 1n }, approver)).toEqual({ code: "yourApproval" });
  expect(next({ status: "PENDING_APPROVAL", approvalRequestedBy: 1n }, rep)).toEqual({ code: "waitingApproval" });
  // An approver can't approve their own request when the shop requires a different approver…
  expect(next({ status: "PENDING_APPROVAL", approvalRequestedBy: 2n }, approver)).toEqual({ code: "waitingApproval" });
  // …and can when it doesn't.
  expect(
    next({ status: "PENDING_APPROVAL", approvalRequestedBy: 2n }, { ...approver, requireDifferentApprover: false }),
  ).toEqual({ code: "yourApproval" });
});

test("approved, draft and closed quotes", () => {
  expect(next({ status: "APPROVED" })).toEqual({ code: "readyToSend" });
  expect(next({ status: "DRAFT" })).toBeNull();
  expect(next({ status: "ORDERED" })).toBeNull();
});

test("sent: expiry in shop-local days, then views", () => {
  // 04:59 UTC on Nov 29 is still Nov 28 in New York.
  expect(next({ expiresAt: new Date("2026-11-29T04:59:00Z") })).toEqual({ code: "expires", days: 0 });
  expect(next({ expiresAt: new Date("2026-12-01T12:00:00Z") })).toEqual({ code: "expires", days: 3 });
  expect(next({ expiresAt: new Date("2026-12-02T12:00:00Z") })).toEqual({ code: "notOpened" });
  expect(next({ lastViewedAt: new Date("2026-11-27T20:00:00Z") })).toEqual({ code: "viewed", days: 1 });
  // A view before the last send doesn't count.
  expect(next({ lastViewedAt: new Date("2026-11-19T12:00:00Z") })).toEqual({ code: "notOpened" });
});
