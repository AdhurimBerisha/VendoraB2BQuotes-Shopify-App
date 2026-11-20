import { logger } from "../lib/logger.server";
import type { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import db from "../db.server";
import { addDaysEndOfDay, endOfLocalDay } from "../lib/dates";
import { ConflictError, NotFoundError, UserError } from "../lib/errors";
import { enqueue, getBoss } from "../jobs/queue.server";
import { getCompanyLocation, searchCompanies } from "../shopify/companies.server";
import { updateDraftOrder } from "../shopify/draft-orders.server";
import type { Actor, StaffActor, SystemActor } from "./actor";
import { audit } from "./audit.server";
import { requireCancel, requirePermission } from "./permissions";
import { QUOTE_STATUSES, type QuoteStatus } from "./quote";

// Which statuses each action may start from.
const TRANSITIONS = {
  submit: ["DRAFT"],
  approve: ["PENDING_APPROVAL"],
  reject: ["PENDING_APPROVAL"],
  send: ["APPROVED"],
  revise: ["APPROVED", "SENT", "DECLINED", "EXPIRED"],
  order: ["APPROVED", "SENT"], // a merchant may complete the draft order in Shopify before sending
  decline: ["SENT"],
  expire: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT"],
  cancel: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "DECLINED", "EXPIRED"],
} as const satisfies Record<string, readonly QuoteStatus[]>;
type QuoteAction = keyof typeof TRANSITIONS;

// Atomic status change: succeeds only if the quote is still in an allowed "from" status.
const transition = async (
  tx: Prisma.TransactionClient,
  shop: string,
  quoteId: string,
  action: QuoteAction,
  to: QuoteStatus,
  extra: Prisma.QuoteUpdateManyMutationInput = {},
) => {
  const { count } = await tx.quote.updateMany({
    where: { id: quoteId, shop, status: { in: [...TRANSITIONS[action]] } },
    data: { status: to, ...extra },
  });
  if (count !== 1) throw new ConflictError("quote.errors.invalidTransition", { action });
};

// Company, contact and currency come from Shopify, never from the client.
const quoteFields = async (actor: StaffActor, locationId: string) => {
  const location = await getCompanyLocation(actor.admin, locationId);
  if (!location) throw new UserError("quote.errors.locationNotFound");
  const contact = location.company.mainContact;
  if (!contact) {
    throw new UserError("quote.errors.noMainContact", { company: location.company.name });
  }
  return {
    companyId: location.company.id,
    companyLocationId: location.id,
    companyContactId: contact.id,
    contactCustomerId: contact.customer?.id ?? null,
    currencyCode: location.currency,
    assignedToUserId: actor.userId,
  };
};

const createQuote = async (actor: StaffActor, input: { locationId: string }) => {
  requirePermission(actor, "quote.create");
  const fields = await quoteFields(actor, input.locationId);

  return db.$transaction(async (tx) => {
    const { quote, version } = await insertQuote(tx, actor.shop, fields, actor.userId);
    await audit(tx, actor, quote.id, "quote.created", { number: quote.number });
    logger.info({ shop: actor.shop, quoteId: quote.id, number: quote.number }, "quote created");
    return { ...quote, currentVersionId: version.id };
  });
};

// A new quote with its next number, default expiry and an empty version 1.
const insertQuote = async (
  tx: Prisma.TransactionClient,
  shopId: string,
  fields: Omit<Prisma.QuoteUncheckedCreateInput, "shop" | "number">,
  createdByUserId: bigint | null,
) => {
  // The row lock on Shop hands out numbers one at a time: no gaps from races, no duplicates.
  const shop = await tx.shop.update({ where: { id: shopId }, data: { nextQuoteNumber: { increment: 1 } } });
  const quote = await tx.quote.create({
    data: {
      expiresAt: addDaysEndOfDay(new Date(), shop.defaultExpiryDays, shop.timezone),
      ...fields,
      shop: shopId,
      number: shop.nextQuoteNumber - 1,
    },
  });
  const version = await tx.quoteVersion.create({ data: { quoteId: quote.id, versionNumber: 1, createdByUserId } });
  await tx.quote.update({ where: { id: quote.id }, data: { currentVersionId: version.id } });
  return { quote, version };
};

const getQuote = async (shop: string, id: string) => {
  const quote = await db.quote.findFirst({
    where: { id, shop },
    include: {
      currentVersion: { include: { lines: { orderBy: { position: "asc" } } } },
      versions: { orderBy: { versionNumber: "asc" } },
    },
  });
  if (!quote) throw new NotFoundError();
  return quote;
};

type QuoteFilters = {
  status?: QuoteStatus;
  companyId?: string;
  companyIds?: string[]; // from a company-name search
  number?: number;
};

// Shared by the list and the CSV export.
const quoteWhere = (shop: string, filters: QuoteFilters): Prisma.QuoteWhereInput => ({
  shop,
  status: filters.status,
  number: filters.number,
  companyId: filters.companyIds ? { in: filters.companyIds } : filters.companyId,
});

// The quote list's URL parameters (list page and CSV export): bad values are ignored.
const listFiltersSchema = z.object({
  status: z.enum(QUOTE_STATUSES).optional().catch(undefined),
  q: z.string().trim().max(100).optional().catch(undefined),
  cursor: z.string().max(40).optional().catch(undefined),
});

// Search text → filters: "1042" or "Q-1042" is a quote number, anything else a company name.
const searchFilters = async (actor: StaffActor, q: string | undefined, prefix: string): Promise<QuoteFilters> => {
  const text = q?.trim();
  if (!text) return {};
  const digits = text.toUpperCase().startsWith(prefix.toUpperCase()) ? text.slice(prefix.length) : text;
  if (/^\d+$/.test(digits)) return { number: Number(digits) };
  const companies = await searchCompanies(actor.admin, text);
  return { companyIds: companies.nodes.map((company) => company.id) };
};

const listQuotes = async (
  shop: string,
  filters: QuoteFilters & { cursor?: string; take?: number } = {},
) => {
  const take = Math.min(filters.take ?? 25, 100);
  const rows = await db.quote.findMany({
    where: quoteWhere(shop, filters),
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    include: { currentVersion: { select: { total: true, versionNumber: true } } },
  });
  return {
    quotes: rows.slice(0, take),
    nextCursor: rows.length > take ? rows[take - 1].id : null,
  };
};

// → CANCELLED; its draft order (if any) is deleted in Shopify by the sync job.
const cancelQuote = async (actor: StaffActor, quoteId: string, reason?: string) => {
  const quote = await getQuote(actor.shop, quoteId);
  requireCancel(actor, quote);
  await getBoss(); // start pg-boss outside the transaction (see enqueue)
  await db.$transaction(async (tx) => {
    await transition(tx, actor.shop, quoteId, "cancel", "CANCELLED");
    await audit(tx, actor, quoteId, "quote.cancelled", { reason: reason ?? null });
    if (!quote.draftOrderId) return;
    // QUEUED so runSync can claim it.
    await tx.quote.update({ where: { id: quoteId }, data: { syncStatus: "QUEUED", syncError: null } });
    await enqueue(
      "sync-draft-order",
      { shop: actor.shop, quoteId, op: "delete" },
      { singletonKey: `${quoteId}:delete`, tx },
    );
  });
  logger.info({ shop: actor.shop, quoteId, hadDraftOrder: !!quote.draftOrderId }, "quote cancelled");
};

const OPEN: QuoteStatus[] = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT"];

// New expiry: the end of a shop-local day ("YYYY-MM-DD"), while the quote is still open.
// ponytail: a SENT quote's draft order keeps its old reserveInventoryUntil until the next sync;
// re-sync here if merchants use reserved stock with changed expiries.
const setExpiry = async (actor: StaffActor, quoteId: string, localDate: string) => {
  requirePermission(actor, "quote.edit");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: actor.shop } });
  const expiresAt = endOfLocalDay(localDate, shop.timezone);
  if (!expiresAt) throw new UserError("quote.errors.invalidDate");
  if (expiresAt < new Date()) throw new UserError("quote.errors.expiryInPast");
  await db.$transaction(async (tx) => {
    const { count } = await tx.quote.updateMany({
      where: { id: quoteId, shop: actor.shop, status: { in: OPEN } },
      data: { expiresAt },
    });
    if (count !== 1) throw new ConflictError("quote.errors.invalidTransition", { action: "expire" });
    await audit(tx, actor, quoteId, "quote.expiry_changed", { localDate });
  });
  logger.info({ shop: actor.shop, quoteId, expiresAt: expiresAt.toISOString() }, "quote expiry changed");
};

// Past its expiry → EXPIRED; its draft order is deleted so the invoice link stops working.
// Returns false when there was nothing to do (not due, already closed).
const expireQuote = async (shop: string, quoteId: string, now = new Date()) => {
  const system: SystemActor = { type: "SYSTEM", shop, reason: "expiry" };
  const quote = await db.quote.findFirst({ where: { id: quoteId, shop } });
  if (!quote?.expiresAt || quote.expiresAt > now || !OPEN.includes(quote.status as QuoteStatus)) return false;
  if (quote.draftOrderId) await getBoss(); // start pg-boss outside the transaction (see enqueue)
  await db.$transaction(async (tx) => {
    await transition(tx, shop, quoteId, "expire", "EXPIRED");
    await audit(tx, system, quoteId, "quote.expired", { expiresAt: quote.expiresAt?.toISOString() ?? null });
    if (!quote.draftOrderId) return;
    await tx.quote.update({ where: { id: quoteId }, data: { syncStatus: "QUEUED", syncError: null } });
    await enqueue("sync-draft-order", { shop, quoteId, op: "delete" }, { singletonKey: `${quoteId}:delete`, tx });
  });
  // M3.3: email the assigned rep "quote expired".
  logger.info({ shop, quoteId, hadDraftOrder: !!quote.draftOrderId }, "quote expired");
  return true;
};

const PO_MAX = 100;

// M9.3: the buyer's purchase-order number, on the quote and on its draft order right away (the buyer
// may open checkout next), so the Shopify order carries it. Staff, the customer account page and the
// public quote page end here; each caller checks who may set it. "" clears it.
const savePoNumber = async (
  getAdmin: () => Promise<AdminApiContext>,
  actor: Actor,
  quote: { id: string; shop: string; status: string; draftOrderId: string | null },
  value: string,
) => {
  const poNumber = value.trim() || null;
  if (poNumber && poNumber.length > PO_MAX) throw new UserError("quote.errors.poNumberTooLong", { max: PO_MAX });
  if (!OPEN.includes(quote.status as QuoteStatus)) throw new ConflictError("quote.errors.poNumberClosed");
  // Database first: a sync starting now sends the new number too (draftOrderInput).
  await db.$transaction(async (tx) => {
    await tx.quote.update({ where: { id: quote.id }, data: { poNumber } });
    await audit(tx, actor, quote.id, "quote.po_number_set", { poNumber });
  });
  if (quote.draftOrderId) await updateDraftOrder(await getAdmin(), quote.draftOrderId, { poNumber });
  logger.info(
    { shop: quote.shop, quoteId: quote.id, by: actor.type, cleared: poNumber === null, draftOrder: !!quote.draftOrderId },
    "po number saved",
  );
};

const setPoNumber = async (actor: StaffActor, quoteId: string, poNumber: string) => {
  requirePermission(actor, "quote.edit");
  const quote = await db.quote.findFirst({ where: { id: quoteId, shop: actor.shop } });
  if (!quote) throw new NotFoundError();
  await savePoNumber(async () => actor.admin, actor, quote, poNumber);
};

const quoteLabel = (prefix: string, number: number) => `${prefix}${number}`;

export {
  QUOTE_STATUSES,
  TRANSITIONS,
  cancelQuote,
  createQuote,
  expireQuote,
  getQuote,
  insertQuote,
  listFiltersSchema,
  listQuotes,
  quoteFields,
  quoteLabel,
  quoteWhere,
  savePoNumber,
  searchFilters,
  setExpiry,
  setPoNumber,
  transition,
};
export type { QuoteAction, QuoteFilters, QuoteStatus };
