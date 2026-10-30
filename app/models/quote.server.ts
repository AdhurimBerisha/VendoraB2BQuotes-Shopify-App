import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { ConflictError, NotFoundError, UserError } from "../lib/errors";
import { getCompanyLocation } from "../shopify/companies.server";
import type { StaffActor } from "./actor";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";

type QuoteStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "SENT"
  | "ORDERED"
  | "DECLINED"
  | "EXPIRED"
  | "CANCELLED";

// Which statuses each action may start from.
const TRANSITIONS = {
  submit: ["DRAFT"],
  approve: ["PENDING_APPROVAL"],
  reject: ["PENDING_APPROVAL"],
  send: ["APPROVED"],
  revise: ["APPROVED", "SENT", "DECLINED", "EXPIRED"],
  order: ["SENT"],
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
const createQuote = async (actor: StaffActor, input: { locationId: string }) => {
  requirePermission(actor, "quote.create");
  const location = await getCompanyLocation(actor.admin, input.locationId);
  if (!location) throw new UserError("quote.errors.locationNotFound");
  const contact = location.company.mainContact;
  if (!contact) {
    throw new UserError("quote.errors.noMainContact", { company: location.company.name });
  }

  return db.$transaction(async (tx) => {
    // The row lock on Shop hands out numbers one at a time: no gaps from races, no duplicates.
    const shop = await tx.shop.update({
      where: { id: actor.shop },
      data: { nextQuoteNumber: { increment: 1 } },
    });
    const quote = await tx.quote.create({
      data: {
        shop: actor.shop,
        number: shop.nextQuoteNumber - 1,
        companyId: location.company.id,
        companyLocationId: location.id,
        companyContactId: contact.id,
        contactCustomerId: contact.customer?.id ?? null,
        currencyCode: location.currency,
        assignedToUserId: actor.userId,
        expiresAt: new Date(Date.now() + shop.defaultExpiryDays * 86_400_000), // end of day in shop tz: M2.9
      },
    });
    const firstVersion = await tx.quoteVersion.create({
      data: { quoteId: quote.id, versionNumber: 1, createdByUserId: actor.userId },
    });
    await tx.quote.update({ where: { id: quote.id }, data: { currentVersionId: firstVersion.id } });
    await audit(tx, actor, quote.id, "quote.created", { number: quote.number });
    console.log("quote created", { shop: actor.shop, quoteId: quote.id, number: quote.number });
    return { ...quote, currentVersionId: firstVersion.id };
  });
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

const listQuotes = async (
  shop: string,
  filters: {
    status?: QuoteStatus;
    companyId?: string;
    number?: number;
    cursor?: string;
    take?: number;
  } = {},
) => {
  const take = Math.min(filters.take ?? 25, 100);
  const rows = await db.quote.findMany({
    where: { shop, status: filters.status, companyId: filters.companyId, number: filters.number },
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

const quoteLabel = (prefix: string, number: number) => `${prefix}${number}`;

export { TRANSITIONS, createQuote, getQuote, listQuotes, quoteLabel, transition };
export type { QuoteAction, QuoteStatus };
