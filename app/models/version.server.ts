import { logger } from "../lib/logger.server";
import { Prisma, type QuoteLine } from "@prisma/client";
import db from "../db.server";
import { ConflictError, NotFoundError, UserError } from "../lib/errors";
import { D, type Money } from "../lib/money";
import { getVariantPrices, type VariantPrice } from "../shopify/products.server";
import type { StaffActor } from "./actor";
import { withoutItems } from "./attention";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";
import { type LineProblem, type PricedLine, lineKey, lineTotal, quantityProblems, totals } from "./pricing";
import { insertQuote, quoteFields, transition } from "./quote.server";

// What staff choose per line. Catalog lines are priced from Shopify for the quote's company
// location; custom lines (freight, fees, services; M9.2) carry their own title and unit price.
type DraftLineInput =
  | { variantId: string; quantity: number; overridePrice?: Money | null; discountPct?: Money | null }
  | { custom: { title: string; price: Money }; quantity: number; discountPct?: Money | null };

// A saved line back to input (refresh, duplicate, import, keeping Shopify's version).
const toLineInput = (line: QuoteLine): DraftLineInput =>
  line.variantId
    ? { variantId: line.variantId, quantity: line.quantity, overridePrice: line.overridePrice, discountPct: line.discountPct }
    : { custom: { title: line.titleSnapshot, price: line.catalogPrice }, quantity: line.quantity, discountPct: line.discountPct };

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

// Prices lines at the company location (Shopify, so call it outside any transaction).
// skipMissing drops lines whose variant was deleted instead of failing (duplicating an old quote).
const priceLines = async (
  admin: StaffActor["admin"],
  companyLocationId: string,
  currency: string,
  input: DraftLineInput[],
  quoteDiscountPct: Money | null,
  { skipMissing = false } = {},
) => {
  const variantIds = [...new Set(input.flatMap((line) => ("variantId" in line ? [line.variantId] : [])))];
  const prices = await getVariantPrices(admin, variantIds, companyLocationId);
  const found = skipMissing ? input.filter((line) => !("variantId" in line) || prices.has(line.variantId)) : input;
  const lines = found.map((line) => {
    if ("custom" in line) {
      // No catalog, stock or quantity rules: the entered price is the list price.
      const priced: PricedLine = { quantity: line.quantity, catalogPrice: line.custom.price, discountPct: line.discountPct ?? null };
      return { kind: "custom" as const, title: line.custom.title, priced, problems: [] as LineProblem[] };
    }
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
    return { kind: "catalog" as const, price, priced, problems: lineProblems(price, line.quantity, currency) };
  });
  return { lines, totals: totals(lines.map((line) => line.priced), quoteDiscountPct, currency) };
};
type PricedLines = Awaited<ReturnType<typeof priceLines>>;

// QuoteLine rows for one version.
const lineRows = (versionId: string, lines: PricedLines["lines"], currency: string) =>
  lines.map((line, index) => {
    const { priced, problems } = line;
    const price = line.kind === "catalog" ? line.price : null;
    return {
      versionId,
      position: index,
      variantId: price?.id ?? null,
      productId: price?.productId ?? null,
      sku: price?.sku ?? null,
      titleSnapshot: line.kind === "catalog" ? lineTitle(line.price) : line.title,
      quantity: priced.quantity,
      catalogPrice: priced.catalogPrice,
      overridePrice: priced.overridePrice ?? null,
      discountPct: priced.discountPct ?? null,
      lineTotal: lineTotal(priced, currency),
      problems: problems.length ? problems : undefined,
    };
  });

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
  const { lines, totals: quoteTotals } = await priceLines(
    actor.admin,
    found.companyLocationId,
    currency,
    input,
    quoteDiscountPct,
  );
  logger.info({
    quoteId,
    lines: lines.length,
    total: quoteTotals.total.toString(),
    problems: lines.filter((line) => line.problems.length).length,
  }, "draft lines priced");

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
    await tx.quoteLine.createMany({ data: lineRows(version.id, lines, currency) });
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

  const variantIds = [...new Set(version.lines.flatMap((line) => (line.variantId ? [line.variantId] : [])))];
  const prices = await getVariantPrices(actor.admin, variantIds, quote.companyLocationId);
  let pricesChanged = false;
  let problemsChanged = false;
  for (const line of version.lines) {
    if (!line.variantId) continue; // custom lines have no catalog price to drift
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

  logger.info({ quoteId, pricesChanged, problemsChanged }, "draft refreshed before submit");
  await saveDraftLines(
    actor,
    quoteId,
    quote.lockVersion,
    version.lines.map(toLineInput),
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

// Any quote → a new DRAFT quote for the same company location with the current version's lines,
// re-priced at today's catalog prices. Lines whose product was deleted are left out (`dropped`).
const duplicateQuote = async (actor: StaffActor, sourceId: string) => {
  requirePermission(actor, "quote.create");
  const source = await db.quote.findFirst({
    where: { id: sourceId, shop: actor.shop },
    include: { currentVersion: { include: { lines: { orderBy: { position: "asc" } } } } },
  });
  if (!source?.currentVersion) throw new NotFoundError();
  const from = source.currentVersion;

  // Shopify first, outside the transaction: today's contact, currency and prices.
  const fields = await quoteFields(actor, source.companyLocationId);
  // Override and custom prices are in the old currency: drop them (custom lines count as
  // dropped). A percentage discount still makes sense.
  const sameCurrency = fields.currencyCode === source.currencyCode;
  const input = from.lines.flatMap((line): DraftLineInput[] => {
    const copy = toLineInput(line);
    if (sameCurrency) return [copy];
    return "variantId" in copy ? [{ ...copy, overridePrice: null }] : [];
  });
  const { lines, totals: quoteTotals } = await priceLines(
    actor.admin,
    fields.companyLocationId,
    fields.currencyCode,
    input,
    from.quoteDiscountPct,
    { skipMissing: true },
  );
  const dropped = from.lines.length - lines.length;

  return db.$transaction(async (tx) => {
    const { quote, version } = await insertQuote(tx, actor.shop, fields, actor.userId);
    await tx.quoteLine.createMany({ data: lineRows(version.id, lines, fields.currencyCode) });
    await tx.quoteVersion.update({
      where: { id: version.id },
      data: {
        quoteDiscountPct: from.quoteDiscountPct,
        listTotal: quoteTotals.listTotal,
        subtotal: quoteTotals.subtotal,
        discountTotal: quoteTotals.discountTotal,
        total: quoteTotals.total,
      },
    });
    await audit(tx, actor, quote.id, "quote.created", { number: quote.number, duplicatedFrom: source.number });
    await audit(tx, actor, source.id, "quote.duplicated", { to: quote.number });
    logger.info(
      { shop: actor.shop, sourceId, quoteId: quote.id, lines: lines.length, dropped, sameCurrency },
      "quote duplicated",
    );
    return { id: quote.id, dropped };
  });
};

type LineView = { quantity: number; unitPrice: string; discountPct: string | null; lineTotal: string };
type LineDiff = {
  key: string; // lineKey: variant id or custom:<title>
  title: string;
  change: "added" | "removed" | "changed";
  before?: LineView;
  after?: LineView;
};
type DiffLine = {
  variantId: string | null;
  titleSnapshot: string;
  quantity: number;
  catalogPrice: Money;
  overridePrice: Money | null;
  discountPct: Money | null;
  lineTotal: Money;
};

// What changed from version `before` to `after`, per line (pure).
const diffVersions = (before: { lines: DiffLine[] }, after: { lines: DiffLine[] }): LineDiff[] => {
  const view = (line: DiffLine): LineView => ({
    quantity: line.quantity,
    unitPrice: (line.overridePrice ?? line.catalogPrice).toString(),
    discountPct: line.discountPct?.toString() ?? null,
    lineTotal: line.lineTotal.toString(),
  });
  const keyed = (lines: DiffLine[]) => new Map(lines.map((line) => [lineKey(line.variantId, line.titleSnapshot), line]));
  const old = keyed(before.lines);
  const next = keyed(after.lines);
  const diffs: LineDiff[] = [];
  for (const [key, line] of old) {
    if (!next.has(key)) diffs.push({ key, title: line.titleSnapshot, change: "removed", before: view(line) });
  }
  for (const [key, line] of next) {
    const previous = old.get(key);
    if (!previous) diffs.push({ key, title: line.titleSnapshot, change: "added", after: view(line) });
    else if (JSON.stringify(view(previous)) !== JSON.stringify(view(line))) {
      diffs.push({ key, title: line.titleSnapshot, change: "changed", before: view(previous), after: view(line) });
    }
  }
  return diffs;
};

export {
  diffVersions,
  duplicateQuote,
  lineProblems,
  lineRows,
  priceLines,
  refreshPrices,
  reviseQuote,
  saveDraftLines,
  toLineInput,
};
export type { DraftLineInput, LineDiff };
