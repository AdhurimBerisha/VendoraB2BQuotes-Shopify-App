import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import db from "../db.server";
import { ConflictError, ForbiddenError } from "../lib/errors";
import { D } from "../lib/money";
import { type FakeVariant, fakeShopify } from "../test/fake-shopify";
import { staff, testShop } from "../test/factories";
import { decide, saveApprovalRules, submitQuote } from "./approval.server";
import { DEFAULT_RULES } from "./approval";
import { redactShop } from "./privacy.server";
import { createQuote, getQuote } from "./quote.server";
import { reviseQuote, saveDraftLines } from "./version.server";

const VARIANT = "gid://shopify/ProductVariant/1";
const variants: Record<string, FakeVariant> = { [VARIANT]: { price: "100.00" } };
const shopify = fakeShopify({ variants });

let SHOP: string;
const rep = () => staff(SHOP, shopify.admin, "REP", 1n);
const manager = () => staff(SHOP, shopify.admin, "MANAGER", 2n);
const owner = () => staff(SHOP, shopify.admin, "OWNER", 3n);

beforeAll(async () => {
  SHOP = (await testShop()).id;
  // USD quotes up to 10 000 and 15 % discount pass without approval.
  await saveApprovalRules(owner(), { ...DEFAULT_RULES, maxTotalByCurrency: { USD: 10000 } });
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

beforeEach(() => {
  variants[VARIANT] = { price: "100.00" };
});

// A DRAFT quote with 2 × 100.00 and the given line discount.
const draftQuote = async (discountPct: string | null = null) => {
  const quote = await createQuote(rep(), { locationId: "gid://shopify/CompanyLocation/1" });
  await saveDraftLines(
    rep(),
    quote.id,
    0,
    [{ variantId: VARIANT, quantity: 2, discountPct: discountPct ? D(discountPct) : null }],
    null,
  );
  return quote.id;
};

const history = async (quoteId: string) =>
  (await db.auditEvent.findMany({ where: { shop: SHOP, quoteId }, orderBy: { createdAt: "asc" } })).map(
    (event) => event.action,
  );

test("within the rules a quote is approved straight away", async () => {
  const id = await draftQuote();

  expect(await submitQuote(rep(), id)).toEqual({ needsApproval: false, reasons: [] });

  const quote = await getQuote(SHOP, id);
  expect(quote.status).toBe("APPROVED");
  expect(quote.currentVersion!.lockedAt).not.toBeNull();
  expect(await db.approval.count({ where: { versionId: quote.currentVersionId! } })).toBe(0);
});

test("scenario 2: a discount changed after approval needs approval again", async () => {
  // v1: 10 % is within the 15 % limit → approved without a manager.
  const id = await draftQuote("10");
  await submitQuote(rep(), id);
  const v1 = (await getQuote(SHOP, id)).currentVersion!;

  // Revise → v2 as a DRAFT copy; raise the discount to 30 % → needs a manager.
  const v2 = await reviseQuote(rep(), id);
  expect(v2.versionNumber).toBe(2);
  let quote = await getQuote(SHOP, id);
  expect(quote.status).toBe("DRAFT");
  expect(quote.currentVersion!.lines.map((l) => l.lineTotal.toFixed(2))).toEqual(["180.00"]);
  await saveDraftLines(rep(), id, quote.lockVersion, [{ variantId: VARIANT, quantity: 2, discountPct: D(30) }], null);

  const result = await submitQuote(rep(), id);
  expect(result.reasons).toEqual([{ code: "DISCOUNT_OVER", detail: "30.0% > 15%" }]);
  quote = await getQuote(SHOP, id);
  expect(quote.status).toBe("PENDING_APPROVAL");

  await decide(manager(), id, "APPROVED", "ok for this customer");
  expect((await getQuote(SHOP, id)).status).toBe("APPROVED");

  // v1 is untouched: still locked, still its own lines and totals.
  const v1After = await db.quoteVersion.findUniqueOrThrow({ where: { id: v1.id }, include: { lines: true } });
  expect(v1After.lockedAt).toEqual(v1.lockedAt);
  expect(v1After.total.toFixed(2)).toBe("180.00");
  const v2Approval = await db.approval.findFirstOrThrow({ where: { versionId: v2.id } });
  expect(v2Approval).toMatchObject({ decision: "APPROVED", requestedBy: 1n, decidedBy: 2n });
  expect(await history(id)).toEqual([
    "quote.created",
    "quote.lines_saved",
    "quote.approved", // v1, automatic
    "quote.revised",
    "quote.lines_saved",
    "quote.submitted", // v2
    "quote.approved", // v2, by the manager
  ]);
});

test("a locked version can't be edited", async () => {
  const id = await draftQuote();
  await submitQuote(rep(), id);
  const { lockVersion } = await getQuote(SHOP, id);

  await expect(
    saveDraftLines(rep(), id, lockVersion, [{ variantId: VARIANT, quantity: 1 }], null),
  ).rejects.toMatchObject({ key: "quote.errors.versionLocked" });
});

test("the requester can't approve their own quote", async () => {
  const id = await draftQuote("30");
  await submitQuote(manager(), id);

  await expect(decide(manager(), id, "APPROVED")).rejects.toMatchObject({
    key: "approval.errors.selfApproval",
  });
  await expect(decide(manager(), id, "APPROVED")).rejects.toBeInstanceOf(ForbiddenError);
});

test("a rep can't approve", async () => {
  const id = await draftQuote("30");
  await submitQuote(rep(), id);

  await expect(decide(rep(), id, "APPROVED")).rejects.toBeInstanceOf(ForbiddenError);
});

test("rejecting needs a comment, then unlocks the same version", async () => {
  const id = await draftQuote("30");
  await submitQuote(rep(), id);

  await expect(decide(manager(), id, "REJECTED", "  ")).rejects.toMatchObject({
    key: "approval.errors.commentRequired",
  });
  await decide(manager(), id, "REJECTED", "too much discount");

  const quote = await getQuote(SHOP, id);
  expect(quote.status).toBe("DRAFT");
  expect(quote.currentVersion!.versionNumber).toBe(1);
  expect(quote.currentVersion!.lockedAt).toBeNull();
  await saveDraftLines(rep(), id, quote.lockVersion, [{ variantId: VARIANT, quantity: 2 }], null);
  const approval = await db.approval.findFirstOrThrow({ where: { versionId: quote.currentVersionId! } });
  expect(approval).toMatchObject({ decision: "REJECTED", comment: "too much discount" });
});

test("nothing to approve on a draft", async () => {
  const id = await draftQuote();
  await expect(decide(manager(), id, "APPROVED")).rejects.toBeInstanceOf(ConflictError);
});

test("a line with a blocking problem can't be submitted", async () => {
  variants[VARIANT] = { price: "100.00", status: "ARCHIVED" };
  const id = await draftQuote();

  await expect(submitQuote(rep(), id)).rejects.toMatchObject({ key: "quote.errors.blockingProblems" });
  expect((await getQuote(SHOP, id)).status).toBe("DRAFT");
});

test("a product archived after saving is caught at submit", async () => {
  const id = await draftQuote();
  variants[VARIANT] = { price: "100.00", status: "ARCHIVED" };

  await expect(submitQuote(rep(), id)).rejects.toMatchObject({ key: "quote.errors.blockingProblems" });
});

test("catalog price changed since editing: lines re-priced, user must review", async () => {
  const id = await draftQuote();
  variants[VARIANT] = { price: "110.00" };

  await expect(submitQuote(rep(), id)).rejects.toMatchObject({ key: "quote.errors.pricesChanged" });
  let quote = await getQuote(SHOP, id);
  expect(quote.status).toBe("DRAFT");
  expect(quote.currentVersion!.total.toFixed(2)).toBe("220.00");

  await submitQuote(rep(), id); // second try: prices match now
  quote = await getQuote(SHOP, id);
  expect(quote.status).toBe("APPROVED");
});

test("an empty quote can't be submitted", async () => {
  const quote = await createQuote(rep(), { locationId: "gid://shopify/CompanyLocation/1" });
  await expect(submitQuote(rep(), quote.id)).rejects.toMatchObject({ key: "quote.errors.noLines" });
});

test("two submits at once: one wins, one approval row", async () => {
  const id = await draftQuote("30");

  const results = await Promise.allSettled([submitQuote(rep(), id), submitQuote(rep(), id)]);

  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  const quote = await getQuote(SHOP, id);
  expect(await db.approval.count({ where: { versionId: quote.currentVersionId! } })).toBe(1);
});

test("only owners change approval rules", async () => {
  await expect(saveApprovalRules(manager(), DEFAULT_RULES)).rejects.toBeInstanceOf(ForbiddenError);
});
