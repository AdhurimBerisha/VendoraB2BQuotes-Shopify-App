import db from "../db.server";
import { ConflictError, NotFoundError } from "../lib/errors";
import { type Money, ZERO, roundMoney, sum } from "../lib/money";
import type { StaffActor } from "./actor";
import { audit } from "./audit.server";

type LineInput = {
  variantId: string;
  productId: string;
  sku: string | null;
  title: string;
  quantity: number;
  catalogPrice: Money;
  overridePrice?: Money | null;
  discountPct?: Money | null;
};

// Replaces all lines of the current (unlocked) version. Optimistic lock on Quote.lockVersion:
// pass the lockVersion the page loaded; a stale one means someone else saved first.
// Prices are supplied by the caller until M2.3 looks them up.
const saveDraftLines = async (
  actor: StaffActor,
  quoteId: string,
  lockVersion: number,
  lines: LineInput[],
  quoteDiscountPct: Money | null,
) =>
  db.$transaction(async (tx) => {
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
    const currency = quote.currencyCode;
    // ponytail: simple totals; M2.3 moves this to models/pricing.ts (price breaks, per-line rounding rules).
    const lineTotals = lines.map((line) => {
      const gross = (line.overridePrice ?? line.catalogPrice).mul(line.quantity);
      const net = line.discountPct ? gross.minus(gross.mul(line.discountPct).div(100)) : gross;
      return roundMoney(net, currency);
    });
    const listTotal = sum(lines.map((line) => roundMoney(line.catalogPrice.mul(line.quantity), currency)));
    const subtotal = sum(lineTotals);
    const quoteDiscount = quoteDiscountPct
      ? roundMoney(subtotal.mul(quoteDiscountPct).div(100), currency)
      : ZERO;
    const total = subtotal.minus(quoteDiscount);

    await tx.quoteLine.deleteMany({ where: { versionId: version.id } });
    await tx.quoteLine.createMany({
      data: lines.map((line, index) => ({
        versionId: version.id,
        position: index,
        variantId: line.variantId,
        productId: line.productId,
        sku: line.sku,
        titleSnapshot: line.title,
        quantity: line.quantity,
        catalogPrice: line.catalogPrice,
        overridePrice: line.overridePrice ?? null,
        discountPct: line.discountPct ?? null,
        lineTotal: lineTotals[index],
      })),
    });
    await tx.quoteVersion.update({
      where: { id: version.id },
      data: { quoteDiscountPct, listTotal, subtotal, total, discountTotal: listTotal.minus(total) },
    });
    await audit(tx, actor, quoteId, "quote.lines_saved", {
      version: version.versionNumber,
      lines: lines.length,
      total: total.toString(),
    });
  });

export { saveDraftLines };
export type { LineInput };
