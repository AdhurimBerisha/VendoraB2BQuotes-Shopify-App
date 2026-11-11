import { logger } from "../lib/logger.server";
import { Prisma } from "@prisma/client";
import db from "../db.server";
import { ConflictError, NotFoundError, UserError } from "../lib/errors";
import { quoteTag, removeDraftTags } from "../shopify/draft-orders.server";
import type { StaffActor } from "./actor";
import { ATTENTION_ACTIONS, type AttentionAction, type AttentionCode, attentionItems, withoutItems } from "./attention";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";
import { type QuoteStatus, TRANSITIONS, cancelQuote } from "./quote.server";
import { requestSync, sendQuote } from "./sync.server";
import { reviseQuote, saveDraftLines } from "./version.server";

// Separate from attention.server.ts: sync.server imports that file, and these actions call sync.

const isRevisable = (status: string) => (TRANSITIONS.revise as readonly string[]).includes(status as QuoteStatus);

// "gid://shopify/ProductVariant/1:2|…" (linesKey in webhooks.server.ts) → lines.
const parseLinesKey = (key: string) =>
  key
    .split("|")
    .filter(Boolean)
    .map((part) => {
      const at = part.lastIndexOf(":");
      return { variantId: part.slice(0, at), quantity: Number(part.slice(at + 1)) };
    })
    .filter((line) => line.variantId.startsWith("gid://shopify/ProductVariant/") && Number.isInteger(line.quantity) && line.quantity > 0);

// CHANGED_IN_SHOPIFY → "Keep Shopify's version": a new version with the draft order's lines,
// keeping our overrides and discounts where the variant is still there. Needs approval again.
const acceptShopifyLines = async (actor: StaffActor, quoteId: string, theirs: string) => {
  const lines = parseLinesKey(theirs);
  if (lines.length === 0) throw new UserError("attention.errors.noLines");
  await reviseQuote(actor, quoteId);
  const quote = await db.quote.findFirstOrThrow({
    where: { id: quoteId, shop: actor.shop },
    include: { currentVersion: { include: { lines: true } } },
  });
  const previous = new Map((quote.currentVersion?.lines ?? []).map((line) => [line.variantId, line]));
  await saveDraftLines(
    actor,
    quoteId,
    quote.lockVersion,
    lines.map((line) => ({
      ...line,
      overridePrice: previous.get(line.variantId)?.overridePrice ?? null,
      discountPct: previous.get(line.variantId)?.discountPct ?? null,
    })),
    quote.currentVersion?.quoteDiscountPct ?? null,
  );
};

// Runs the chosen action, then removes the item and records who resolved it. Each action also
// checks its own permission (send, edit, cancel). A failing action leaves the item in place.
const resolveAttention = async (actor: StaffActor, quoteId: string, code: AttentionCode, action: AttentionAction) => {
  requirePermission(actor, "attention.resolve");
  if (!(ATTENTION_ACTIONS[code] as readonly string[] | undefined)?.includes(action)) {
    throw new UserError("errors.invalidInput");
  }
  const quote = await db.quote.findFirst({ where: { id: quoteId, shop: actor.shop } });
  if (!quote) throw new NotFoundError();
  const item = attentionItems(quote.attention).find((existing) => existing.code === code);
  if (!item) throw new ConflictError("attention.errors.gone"); // resolved by someone else meanwhile

  switch (action) {
    case "retry":
    case "recreate":
    case "overwrite":
      await requestSync(actor, quoteId);
      break;
    case "createNew": {
      const ids = Array.isArray(item.data?.draftOrderIds) ? (item.data.draftOrderIds as string[]) : [];
      for (const id of ids) await removeDraftTags(actor.admin, id, [quoteTag(quoteId)]);
      await requestSync(actor, quoteId);
      break;
    }
    case "cancel":
      await cancelQuote(actor, quoteId, "draft order deleted in Shopify");
      break;
    case "acceptShopify":
      await acceptShopifyLines(actor, quoteId, typeof item.data?.theirs === "string" ? item.data.theirs : "");
      break;
    case "editQuote":
    case "revise":
      if (isRevisable(quote.status)) await reviseQuote(actor, quoteId); // DRAFT: already editable
      break;
    case "retrySend":
      await sendQuote(actor, quoteId, "");
      break;
    case "dismiss":
      break;
  }

  await db.$transaction(async (tx) => {
    const fresh = await tx.quote.findUniqueOrThrow({ where: { id: quoteId }, select: { attention: true } });
    await tx.quote.update({
      where: { id: quoteId },
      data: { attention: withoutItems(fresh.attention, [code]) ?? Prisma.DbNull },
    });
    await audit(tx, actor, quoteId, "attention.resolved", { code, action });
  });
  logger.info({ shop: actor.shop, quoteId, code, action }, "attention resolved");
};

export { parseLinesKey, resolveAttention };
