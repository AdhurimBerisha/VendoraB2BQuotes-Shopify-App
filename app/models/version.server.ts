import db from "../db.server";
import { ConflictError, NotFoundError, UserError } from "../lib/errors";
import { D, type Money } from "../lib/money";
import { getVariantPrices, type VariantPrice } from "../shopify/products.server";
import type { StaffActor } from "./actor";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";
import { type LineProblem, type PricedLine, lineTotal, quantityProblems, totals } from "./pricing";

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

export { saveDraftLines };
export type { DraftLineInput };
