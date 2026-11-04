import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import db from "../db.server";
import { ForbiddenError, UserError } from "../lib/errors";
import { getBoss } from "../jobs/queue.server";
import { contactIdForLocation, getCompanyLocation } from "../shopify/companies.server";
import type { CustomerActor, WebhookActor } from "./actor";
import { audit } from "./audit.server";
import { notify } from "./notify.server";
import { insertQuote, quoteLabel } from "./quote.server";
import { type DraftLineInput, lineRows, priceLines } from "./version.server";

// Quotes buyers ask for (M3.5): a submitted checkout (draft order) or the theme's
// "Request a quote" button. Both become an unassigned DRAFT quote and email the managers.
type RequestSource =
  | { kind: "draftOrder"; actor: WebhookActor; draftOrderId: string; skipped: number }
  | { kind: "button"; actor: CustomerActor; message: string | null };

type Location = NonNullable<Awaited<ReturnType<typeof getCompanyLocation>>>;

const createRequestedQuote = async (
  admin: AdminApiContext,
  shop: string,
  location: Location,
  contact: { id: string; customer?: { id: string } | null },
  input: DraftLineInput[],
  source: RequestSource,
) => {
  // Shopify first, outside the transaction (see saveDraftLines).
  const { lines, totals } = await priceLines(admin, location.id, location.currency, input, null);
  const fromDraft = source.kind === "draftOrder";

  await getBoss(); // start pg-boss outside the transaction (see enqueue)
  return db.$transaction(async (tx) => {
    const { quote, version } = await insertQuote(
      tx,
      shop,
      {
        companyId: location.company.id,
        companyLocationId: location.id,
        companyContactId: contact.id,
        contactCustomerId: contact.customer?.id ?? null,
        currencyCode: location.currency,
        ...(fromDraft && { draftOrderId: source.draftOrderId, syncStatus: "SYNCED" }), // the draft order exists
      },
      null,
    );
    await tx.quoteLine.createMany({ data: lineRows(version.id, lines, location.currency) });
    await tx.quoteVersion.update({
      where: { id: version.id },
      data: {
        listTotal: totals.listTotal,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        total: totals.total,
        // The buyer's message is for staff, not for the quote document.
        internalNote: source.kind === "button" ? source.message : null,
      },
    });
    if (fromDraft) await tx.quote.update({ where: { id: quote.id }, data: { syncedVersionId: version.id } });
    await audit(tx, source.actor, quote.id, "quote.created", {
      number: quote.number,
      source: fromDraft ? "storefront" : "storefront_button",
      ...(fromDraft && { draftOrderId: source.draftOrderId, skipped: source.skipped }),
    });
    await notify(
      tx,
      shop,
      "quoteRequested",
      { kind: "managers" },
      { quoteId: quote.id, comment: source.kind === "button" ? (source.message ?? undefined) : undefined },
    );
    console.log("requested quote created", { shop, quoteId: quote.id, source: source.kind, lines: lines.length });
    return quote;
  });
};

// What the theme block posts: the cart's lines (numeric variant ids from /cart.js) and the
// buyer's current company location (Liquid customer.current_location.id).
const buttonRequestSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  lines: z
    .array(z.object({ variantId: z.coerce.number().int().positive(), quantity: z.coerce.number().int().min(1).max(100_000) }))
    .min(1)
    .max(100),
  message: z.string().trim().max(1000).optional(),
});

// The "Request a quote" button (app proxy). The location comes from the browser, so the
// buyer must hold a role there; prices come from Shopify, never from the browser.
const requestQuoteFromStorefront = async (admin: AdminApiContext, shop: string, customerId: string, body: unknown) => {
  const parsed = buttonRequestSchema.safeParse(body);
  if (!parsed.success) throw new UserError("errors.invalidInput");
  const { locationId, lines, message } = parsed.data;
  const locationGid = `gid://shopify/CompanyLocation/${locationId}`;

  const [contactId, location] = await Promise.all([
    contactIdForLocation(admin, customerId, locationGid),
    getCompanyLocation(admin, locationGid),
  ]);
  if (!contactId || !location) {
    console.warn("quote request refused: buyer can't buy for this location", { shop, locationId });
    throw new ForbiddenError();
  }
  const actor: CustomerActor = { type: "CUSTOMER", shop, customerId };
  const quote = await createRequestedQuote(
    admin,
    shop,
    location,
    { id: contactId, customer: { id: customerId } },
    lines.map((line) => ({ variantId: `gid://shopify/ProductVariant/${line.variantId}`, quantity: line.quantity })),
    { kind: "button", actor, message: message || null },
  );
  const shopRow = await db.shop.findUnique({ where: { id: shop }, select: { quotePrefix: true } });
  return quoteLabel(shopRow?.quotePrefix ?? "Q-", quote.number); // shown to the buyer
};

export { createRequestedQuote, requestQuoteFromStorefront };
