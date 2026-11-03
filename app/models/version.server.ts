import { Prisma } from "@prisma/client";
import db from "../db.server";
import { ConflictError, NotFoundError, UserError } from "../lib/errors";
import { D, type Money } from "../lib/money";
import { getVariantPrices, type VariantPrice } from "../shopify/products.server";
import type { StaffActor } from "./actor";
import { withoutItems } from "./attention";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";
import { type LineProblem, type PricedLine, lineTotal, quantityProblems, totals } from "./pricing";
import { transition } from "./quote.server";

// What staff choose per line; catalog prices come from Shopify for the quote's company location.
type DraftLineInput = {
  variantId: string;
  quantity: number;
  overridePrice?: Money | null;
  discountPct?: Money | null;
};

const lineProblems = (
  price: VariantPrice,
  quantity: number,
  quoteCurrency: string,
): LineProblem[] => {
  const problems = quantityProblems(quantity, price.quantityRule);
  if (price.status !== "ACTIVE") problems.push("PRODUCT_NOT_ACTIVE");
  if (price.isGiftCard) problems.push("GIFT_CARD");
  // The location's market changed after the quote was created (D-14: one currency per quote).
  if (price.currencyCode !== quoteCurrency) problems.push("CURRENCY_MISMATCH");
  if (price.tracked && price.inventoryQuantity !== null && price.inventoryQuantity < quantity) {
    problems.push("OUT_OF_STOCK");
  }
  return problems;
};

const lineTitle = (price: VariantPrice) =>
  price.title === "Default Title" ? price.productTitle : `${price.productTitle} – ${price.title}`;

// Replaces all lines of the current (unlocked) version. Optimistic lock on Quote.lockVersion:
// pass the lockVersion the page loaded; a stale one means someone else saved first.
const saveDraftLines = async (
  actor: StaffActor,
  quoteId: string,
  lockVersion: number,
  input: DraftLineInput[],
  quoteDiscountPct: Money | null,
) => {
  requirePermission(actor, "quote.edit");
  const found = await db.quote.findFirst({ where: { id: quoteId, shop: actor.shop } });
  if (!found) throw new NotFoundError();
  const currency = found.currencyCode;

  // Shopify first, outside the transaction, so a slow API call doesn't hold database locks.
  const variantIds = [...new Set(input.map((line) => line.variantId))];
  const prices = await getVariantPrices(actor.admin, variantIds, found.companyLocationId);

  const lines = input.map((line) => {
    const price = prices.get(line.variantId);
    if (!price) throw new UserError("quote.errors.variantNotFound", { variantId: line.variantId });
    const priced: PricedLine = {
      quantity: line.quantity,
      catalogPrice: D(price.price),
      overridePrice: line.overridePrice ?? null,
      discountPct: line.discountPct ?? null,
      priceBreaks: price.priceBreaks.map((priceBreak) => ({
        minimumQuantity: priceBreak.minimumQuantity,
        price: D(priceBreak.price),
      })),
    };
    return { price, priced, problems: lineProblems(price, line.quantity, currency) };
  });
  const quoteTotals = totals(lines.map((line) => line.priced), quoteDiscountPct, currency);
  console.log("draft lines priced", {
    quoteId,
    lines: lines.length,
    total: quoteTotals.total.toString(),
    problems: lines.filter((line) => line.problems.length).length,
  });

  return db.$transaction(async (tx) => {
    const quote = await tx.quote.findFirst({
      where: { id: quoteId, shop: actor.shop },
      include: { currentVersion: true },
    });
    if (!quote?.currentVersion) throw new NotFoundError();
    if (quote.currentVersion.lockedAt) throw new ConflictError("quote.errors.versionLocked");

    const bumped = await tx.quote.updateMany({
      where: { id: quoteId, shop: actor.shop, lockVersion },
      data: { lockVersion: { increment: 1 } },
    });
    if (bumped.count !== 1) throw new ConflictError("quote.errors.changedByOther");

    const version = quote.currentVersion;
    await tx.quoteLine.deleteMany({ where: { versionId: version.id } });
    await tx.quoteLine.createMany({
      data: lines.map(({ price, priced, problems }, index) => ({
        versionId: version.id,
        position: index,
        variantId: price.id,
        productId: price.productId,
        sku: price.sku,
        titleSnapshot: lineTitle(price),
        quantity: priced.quantity,
        catalogPrice: priced.catalogPrice,
        overridePrice: priced.overridePrice,
        discountPct: priced.discountPct,
        lineTotal: lineTotal(priced, currency),
        problems: problems.length ? problems : undefined,
      })),
    });
    await tx.quoteVersion.update({
      where: { id: version.id },
      data: {
        quoteDiscountPct,
        listTotal: quoteTotals.listTotal,
        subtotal: quoteTotals.subtotal,
        discountTotal: quoteTotals.discountTotal,
        total: quoteTotals.total,
      },
    });
    await audit(tx, actor, quoteId, "quote.lines_saved", {
      version: version.versionNumber,
      lines: lines.length,
      total: quoteTotals.total.toString(),
    });
  });
};

// Before submit (and send, M2.6): re-check the current draft against Shopify. If catalog prices
// moved, the lines are re-saved and the user must review them (quote.errors.pricesChanged).
// If only line problems changed (product archived, stock), the lines are re-saved silently.
const refreshPrices = async (actor: StaffActor, quoteId: string) => {
  const quote = await db.quote.findFirst({
    where: { id: quoteId, shop: actor.shop },
    include: { currentVersion: { include: { lines: { orderBy: { position: "asc" } } } } },
  });
  if (!quote?.currentVersion) throw new NotFoundError();
  const version = quote.currentVersion;
  if (version.lines.length === 0) return;

  const variantIds = [...new Set(version.lines.map((line) => line.variantId))];
  const prices = await getVariantPrices(actor.admin, variantIds, quote.companyLocationId);
  let pricesChanged = false;
  let problemsChanged = false;
  for (const line of version.lines) {
    const price = prices.get(line.variantId);
    if (!price || !D(price.price).eq(line.catalogPrice)) pricesChanged = true;
    else if (
      JSON.stringify(line.problems ?? []) !==
      JSON.stringify(lineProblems(price, line.quantity, quote.currencyCode))
    ) {
      problemsChanged = true;
    }
  }
  if (!pricesChanged && !problemsChanged) return;

  console.log("draft refreshed before submit", { quoteId, pricesChanged, problemsChanged });
  await saveDraftLines(
    actor,
    quoteId,
    quote.lockVersion,
    version.lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      overridePrice: line.overridePrice,
      discountPct: line.discountPct,
    })),
    version.quoteDiscountPct,
  );
  if (pricesChanged) throw new UserError("quote.errors.pricesChanged");
};

// APPROVED / SENT / DECLINED / EXPIRED → a new DRAFT version with a copy of the lines.
// The old version and its approval stay locked forever (scenario 2).
const reviseQuote = async (actor: StaffActor, quoteId: string) => {
  requirePermission(actor, "quote.edit");
  return db.$transaction(async (tx) => {
    const quote = await tx.quote.findFirst({
      where: { id: quoteId, shop: actor.shop },
      include: { currentVersion: { include: { lines: { orderBy: { position: "asc" } } } } },
    });
    const old = quote?.currentVersion;
    if (!quote || !old) throw new NotFoundError();
    await transition(tx, actor.shop, quoteId, "revise", "DRAFT");

    const next = await tx.quoteVersion.create({
      data: {
        quoteId,
        versionNumber: old.versionNumber + 1,
        createdByUserId: actor.userId,
        quoteDiscountPct: old.quoteDiscountPct,
        listTotal: old.listTotal,
        subtotal: old.subtotal,
        discountTotal: old.discountTotal,
        total: old.total,
        note: old.note,
        internalNote: old.internalNote,
        lines: {
          create: old.lines.map((line) => ({
            position: line.position,
            variantId: line.variantId,
            productId: line.productId,
            sku: line.sku,
            titleSnapshot: line.titleSnapshot,
            quantity: line.quantity,
            catalogPrice: line.catalogPrice,
            overridePrice: line.overridePrice,
            discountPct: line.discountPct,
            lineTotal: line.lineTotal,
            problems: line.problems ?? undefined,
          })),
        },
      },
    });
    await tx.quote.update({
      where: { id: quoteId },
      data: {
        currentVersionId: next.id,
        lockVersion: { increment: 1 },
        // The new version answers the buyer's change request.
        attention: withoutItems(quote.attention, ["CHANGES_REQUESTED"]) ?? Prisma.DbNull,
      },
    });
    await audit(tx, actor, quoteId, "quote.revised", { from: old.versionNumber, to: next.versionNumber });
    return next;
  });
};

type LineView = { quantity: number; unitPrice: string; discountPct: string | null; lineTotal: string };
type LineDiff = {
  variantId: string;
  title: string;
  change: "added" | "removed" | "changed";
  before?: LineView;
  after?: LineView;
};
type DiffLine = {
  variantId: string;
  titleSnapshot: string;
  quantity: number;
  catalogPrice: Money;
  overridePrice: Money | null;
  discountPct: Money | null;
  lineTotal: Money;
};

// What changed from version `before` to `after`, per variant (pure).
const diffVersions = (before: { lines: DiffLine[] }, after: { lines: DiffLine[] }): LineDiff[] => {
  const view = (line: DiffLine): LineView => ({
    quantity: line.quantity,
    unitPrice: (line.overridePrice ?? line.catalogPrice).toString(),
    discountPct: line.discountPct?.toString() ?? null,
    lineTotal: line.lineTotal.toString(),
  });
  const old = new Map(before.lines.map((line) => [line.variantId, line]));
  const next = new Map(after.lines.map((line) => [line.variantId, line]));
  const diffs: LineDiff[] = [];
  for (const [variantId, line] of old) {
    if (!next.has(variantId)) diffs.push({ variantId, title: line.titleSnapshot, change: "removed", before: view(line) });
  }
  for (const [variantId, line] of next) {
    const previous = old.get(variantId);
    if (!previous) diffs.push({ variantId, title: line.titleSnapshot, change: "added", after: view(line) });
    else if (JSON.stringify(view(previous)) !== JSON.stringify(view(line))) {
      diffs.push({ variantId, title: line.titleSnapshot, change: "changed", before: view(previous), after: view(line) });
    }
  }
  return diffs;
};

export { diffVersions, refreshPrices, reviseQuote, saveDraftLines };
export type { DraftLineInput, LineDiff };
