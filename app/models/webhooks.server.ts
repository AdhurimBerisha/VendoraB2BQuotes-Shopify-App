import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { addDraftTags, getSubmittedDraft, quoteTag } from "../shopify/draft-orders.server";
import { getCompanyLocation } from "../shopify/companies.server";
import type { WebhookActor } from "./actor";
import { raise } from "./attention.server";
import { notify } from "./notify.server";
import { audit } from "./audit.server";
import type { LineProblem } from "./pricing";
import { createRequestedQuote } from "./quote-request.server";
import { type QuoteStatus, transition } from "./quote.server";

// Shopify webhook payloads (REST shape: numeric ids, snake_case), only the fields we read.
type DraftOrderPayload = {
  id: number;
  status: "open" | "invoice_sent" | "completed";
  order_id: number | null;
  updated_at: string;
  line_items: { variant_id: number | null; quantity: number }[];
};
type ProductPayload = { id: number; status?: string };
type GetAdmin = (shop: string) => Promise<AdminApiContext>;

const defaultGetAdmin: GetAdmin = async (shop) => (await unauthenticated.admin(shop)).admin;

const ACTIVE: QuoteStatus[] = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT"];
const gid = (type: string, id: number) => `gid://shopify/${type}/${id}`;
const webhookActor = (shop: string, topic: string): WebhookActor => ({ type: "WEBHOOK", shop, reason: topic });

// Order-independent fingerprint of variant × quantity.
const linesKey = (lines: { variantId: string; quantity: number }[]) =>
  lines
    .map((line) => `${line.variantId}:${line.quantity}`)
    .sort()
    .join("|");

const processWebhook = async (topic: string, shop: string, payload: unknown, getAdmin = defaultGetAdmin) => {
  console.log("processing webhook", { topic, shop });
  switch (topic) {
    case "DRAFT_ORDERS_CREATE":
      return onDraftCreate(shop, payload as { id: number; tags?: string }, getAdmin);
    case "DRAFT_ORDERS_UPDATE":
      return onDraftUpdate(shop, payload as DraftOrderPayload);
    case "DRAFT_ORDERS_DELETE":
      return onDraftDelete(shop, payload as { id: number });
    case "PRODUCTS_DELETE":
      return onProductGone(shop, payload as ProductPayload, "PRODUCT_DELETED");
    case "PRODUCTS_UPDATE": {
      const product = payload as ProductPayload;
      if (product.status && product.status !== "active") {
        return onProductGone(shop, product, "PRODUCT_NOT_ACTIVE");
      }
      return;
    }
    default:
      console.warn("unhandled webhook topic", { topic, shop });
  }
};

const onDraftUpdate = async (shop: string, payload: DraftOrderPayload) => {
  const quote = await db.quote.findFirst({
    where: { shop, draftOrderId: gid("DraftOrder", payload.id) },
    include: { versions: { include: { lines: true } } },
  });
  if (!quote) return; // not ours
  const updatedAt = new Date(payload.updated_at);
  // Scenario 6: a duplicate, an out-of-order delivery, or our own change.
  if (quote.shopifyUpdatedAt && updatedAt <= quote.shopifyUpdatedAt) {
    console.log("draft order webhook ignored (not newer)", { quoteId: quote.id });
    return;
  }
  const actor = webhookActor(shop, "draft_orders/update");

  await db.$transaction(async (tx) => {
    await tx.quote.update({ where: { id: quote.id }, data: { shopifyUpdatedAt: updatedAt } });

    if (payload.status === "completed" && payload.order_id) {
      // Scenario 1: Shopify completes a draft order only once.
      const orderId = gid("Order", payload.order_id);
      if (quote.status === "APPROVED" || quote.status === "SENT") {
        await transition(tx, shop, quote.id, "order", "ORDERED", { orderId });
        await audit(tx, actor, quote.id, "quote.ordered", { orderId });
        await notify(tx, shop, "quoteOrdered", { kind: "user", userId: quote.assignedToUserId }, { quoteId: quote.id });
      } else if (quote.status !== "ORDERED") {
        // e.g. the buyer paid just before the quote was cancelled: keep the order, tell a human.
        await tx.quote.update({ where: { id: quote.id }, data: { orderId } });
        await raise(tx, shop, quote.id, { code: "ORDER_ON_CLOSED_QUOTE", data: { orderId, status: quote.status } });
      }
      return;
    }

    // Our own sync is writing this draft order right now; the next webhook compares again.
    if (quote.syncStatus === "QUEUED" || quote.syncStatus === "SYNCING") return;
    const synced = quote.versions.find((version) => version.id === quote.syncedVersionId);
    if (!synced) return;
    const ours = linesKey(synced.lines);
    const theirs = linesKey(
      payload.line_items.flatMap((line) =>
        line.variant_id ? [{ variantId: gid("ProductVariant", line.variant_id), quantity: line.quantity }] : [],
      ),
    );
    if (ours === theirs) return;
    // Scenario 16: someone edited the draft order in Shopify.
    await tx.quote.update({ where: { id: quote.id }, data: { syncStatus: "NEEDS_ATTENTION" } });
    await raise(tx, shop, quote.id, { code: "CHANGED_IN_SHOPIFY", data: { ours, theirs } });
    await audit(tx, actor, quote.id, "attention.raised", { code: "CHANGED_IN_SHOPIFY" });
  });
};

// M3.5: a company draft order made outside Vendora (a B2B checkout submitted for review, or
// one made in the Shopify admin) becomes a DRAFT quote, when Settings → General allows it.
// The draft order stays the quote's draft order; later syncs overwrite it with the quote.
const onDraftCreate = async (shop: string, payload: { id: number; tags?: string }, getAdmin: GetAdmin) => {
  const isOurs = (tags: string[]) => tags.some((tag) => tag.trim().startsWith("vendora-quote-"));
  if (isOurs((payload.tags ?? "").split(","))) return; // made by our own sync
  const shopRow = await db.shop.findUnique({ where: { id: shop } });
  if (!shopRow?.importSubmittedDrafts || shopRow.uninstalledAt) return;

  const draftOrderId = gid("DraftOrder", payload.id);
  const admin = await getAdmin(shop);
  const draft = await getSubmittedDraft(admin, draftOrderId);
  if (!draft || isOurs(draft.tags)) return;
  const purchase = draft.purchasingEntity;
  if (!purchase || !("company" in purchase)) {
    console.log("draft order ignored: not a company purchase", { shop, draftOrderId });
    return;
  }

  // A retry after the quote was saved but before the tag was added: only tag it.
  const existing = await db.quote.findFirst({ where: { shop, draftOrderId }, select: { id: true } });
  const quoteId = existing?.id ?? (await importDraft(admin, shop, draftOrderId, draft, purchase));
  if (!quoteId) return;
  await addDraftTags(admin, draftOrderId, [quoteTag(quoteId)]);
};

type SubmittedDraft = NonNullable<Awaited<ReturnType<typeof getSubmittedDraft>>>;
type CompanyPurchase = Extract<NonNullable<SubmittedDraft["purchasingEntity"]>, { company: unknown }>;

const importDraft = async (
  admin: AdminApiContext,
  shop: string,
  draftOrderId: string,
  draft: SubmittedDraft,
  purchase: CompanyPurchase,
) => {
  const location = await getCompanyLocation(admin, purchase.location.id);
  const contact = purchase.contact ?? location?.company.mainContact;
  if (!location || !contact) {
    console.warn("draft order ignored: location or contact missing", { shop, draftOrderId });
    return null;
  }
  // Custom items (no variant) can't be quoted; the next sync drops them from the draft order.
  const input = draft.lineItems.nodes.flatMap((line) =>
    line.variant ? [{ variantId: line.variant.id, quantity: line.quantity }] : [],
  );
  const actor = webhookActor(shop, "draft_orders/create");
  const skipped = draft.lineItems.nodes.length - input.length;
  const quote = await createRequestedQuote(admin, shop, location, contact, input, {
    kind: "draftOrder",
    actor,
    draftOrderId,
    skipped,
  });
  return quote.id;
};

const onDraftDelete = async (shop: string, payload: { id: number }) => {
  const quote = await db.quote.findFirst({ where: { shop, draftOrderId: gid("DraftOrder", payload.id) } });
  // Cancelled quotes delete their own draft orders.
  if (!quote || !ACTIVE.includes(quote.status as QuoteStatus)) return;
  await db.$transaction(async (tx) => {
    await tx.quote.update({
      where: { id: quote.id },
      data: { draftOrderId: null, syncedVersionId: null, syncStatus: "NEEDS_ATTENTION" },
    });
    await raise(tx, shop, quote.id, { code: "DRAFT_DELETED" });
    await audit(tx, webhookActor(shop, "draft_orders/delete"), quote.id, "attention.raised", {
      code: "DRAFT_DELETED",
    });
  });
};

// Scenario 9: flag the product's lines on the current version of every open quote.
// Older versions stay as they were.
const onProductGone = async (
  shop: string,
  payload: ProductPayload,
  code: "PRODUCT_DELETED" | "PRODUCT_NOT_ACTIVE",
) => {
  const productId = gid("Product", payload.id);
  const lines = await db.quoteLine.findMany({
    where: { productId, version: { currentOf: { is: { shop, status: { in: ACTIVE } } } } },
    include: { version: { select: { quoteId: true } } },
  });
  for (const line of lines) {
    const problems = new Set([...((line.problems as LineProblem[] | null) ?? []), code]);
    await db.$transaction(async (tx) => {
      await tx.quoteLine.update({ where: { id: line.id }, data: { problems: [...problems] } });
      await raise(tx, shop, line.version.quoteId, { code, data: { productId, title: line.titleSnapshot } });
    });
  }
  console.log("product lines flagged", { shop, productId, code, lines: lines.length });
};

export { linesKey, processWebhook };
