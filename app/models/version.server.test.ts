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
import { diffVersions, duplicateQuote, reviseQuote, saveDraftLines } from "./version.server";

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

test("10 submits at once: one wins, one approval row", async () => {
  const id = await draftQuote("30");

  const results = await Promise.allSettled(Array.from({ length: 10 }, () => submitQuote(rep(), id)));

  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const quote = await getQuote(SHOP, id);
  expect(quote.status).toBe("PENDING_APPROVAL");
  expect(await db.approval.count({ where: { versionId: quote.currentVersionId! } })).toBe(1);
});

test("a save sent from a page opened before submit is rejected, the locked version is unchanged", async () => {
  const id = await draftQuote();
  const { lockVersion } = await getQuote(SHOP, id); // the rep's open page

  await submitQuote(manager(), id);

  await expect(
    saveDraftLines(rep(), id, lockVersion, [{ variantId: VARIANT, quantity: 9 }], null),
  ).rejects.toMatchObject({ key: "quote.errors.versionLocked" });
  expect((await getQuote(SHOP, id)).currentVersion!.lines.map((l) => l.quantity)).toEqual([2]);
});

test("save and submit at once: the submitted version holds the lines it was approved with", async () => {
  const id = await draftQuote();
  const { lockVersion } = await getQuote(SHOP, id);

  const [saved, submitted] = await Promise.allSettled([
    saveDraftLines(rep(), id, lockVersion, [{ variantId: VARIANT, quantity: 3 }], null),
    submitQuote(manager(), id),
  ]);

  expect(submitted.status).toBe("fulfilled");
  const quote = await getQuote(SHOP, id);
  expect(quote.status).toBe("APPROVED");
  // Either the save got in first (3 × 100) or it was rejected (2 × 100); totals always match the lines.
  const quantity = saved.status === "fulfilled" ? 3 : 2;
  expect(quote.currentVersion!.lines.map((l) => l.quantity)).toEqual([quantity]);
  expect(quote.currentVersion!.total.toFixed(2)).toBe((quantity * 100).toFixed(2));
});

test("approve and revise at the same moment: one consistent state", async () => {
  const id = await draftQuote("30");
  await submitQuote(rep(), id);

  const [approved] = await Promise.allSettled([decide(manager(), id, "APPROVED"), reviseQuote(rep(), id)]);
  expect(approved.status).toBe("fulfilled"); // the approval never loses: revise can't run on a pending quote

  // revise only works from APPROVED: either it ran after the approval (DRAFT, v2 unlocked)
  // or it failed and the quote stays APPROVED with v1 locked. Never both.
  const quote = await getQuote(SHOP, id);
  const version = quote.currentVersion!;
  if (quote.status === "DRAFT") {
    expect(version).toMatchObject({ versionNumber: 2, lockedAt: null });
  } else {
    expect(quote.status).toBe("APPROVED");
    expect(version.versionNumber).toBe(1);
    expect(version.lockedAt).not.toBeNull();
  }
});

test("only owners change approval rules", async () => {
  await expect(saveApprovalRules(manager(), DEFAULT_RULES)).rejects.toBeInstanceOf(ForbiddenError);
});

test("duplicate: a new DRAFT at today's prices, deleted products left out, history on both", async () => {
  const GONE = "gid://shopify/ProductVariant/2";
  variants[GONE] = { price: "5.00" };
  const sourceId = await draftQuote("10");
  const source = await getQuote(SHOP, sourceId);
  await saveDraftLines(
    rep(),
    sourceId,
    source.lockVersion,
    [
      { variantId: VARIANT, quantity: 2, discountPct: D(10) },
      { variantId: GONE, quantity: 1 },
    ],
    null,
  );
  await submitQuote(rep(), sourceId);
  variants[VARIANT] = { price: "120.00" };
  delete variants[GONE];

  const { id, dropped } = await duplicateQuote(rep(), sourceId);

  expect(dropped).toBe(1);
  const copy = await getQuote(SHOP, id);
  expect(copy.status).toBe("DRAFT");
  expect(copy.number).not.toBe(source.number);
  expect(copy.companyLocationId).toBe(source.companyLocationId);
  expect(copy.currentVersion!.versionNumber).toBe(1);
  // 2 × 120.00 − 10 % = 216.00
  expect(copy.currentVersion!.lines.map((l) => [l.variantId, l.lineTotal.toFixed(2)])).toEqual([[VARIANT, "216.00"]]);
  expect(copy.currentVersion!.total.toFixed(2)).toBe("216.00");
  expect((await getQuote(SHOP, sourceId)).status).toBe("APPROVED");
  expect(await history(id)).toEqual(["quote.created"]);
  expect((await history(sourceId)).at(-1)).toBe("quote.duplicated");
});

test("diffVersions: added, removed and changed lines; unchanged lines left out", () => {
  const line = (variantId: string, quantity: number, discountPct: string | null = null) => ({
    variantId,
    titleSnapshot: `Title ${variantId}`,
    quantity,
    catalogPrice: D(10),
    overridePrice: null,
    discountPct: discountPct === null ? null : D(discountPct),
    lineTotal: D(10 * quantity),
  });
  const v1 = { lines: [line("A", 1), line("B", 2), line("C", 3)] };
  const v2 = { lines: [line("A", 1), line("B", 5, "10"), line("D", 1)] };

  expect(diffVersions(v1, v2)).toEqual([
    { variantId: "C", title: "Title C", change: "removed", before: { quantity: 3, unitPrice: "10", discountPct: null, lineTotal: "30" } },
    {
      variantId: "B",
      title: "Title B",
      change: "changed",
      before: { quantity: 2, unitPrice: "10", discountPct: null, lineTotal: "20" },
      after: { quantity: 5, unitPrice: "10", discountPct: "10", lineTotal: "50" },
    },
    { variantId: "D", title: "Title D", change: "added", after: { quantity: 1, unitPrice: "10", discountPct: null, lineTotal: "10" } },
  ]);
});
