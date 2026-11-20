import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { type Money, toShopifyAmount } from "../lib/money";
import type {
  CountryCode,
  CurrencyCode,
  DraftOrderAppliedDiscountType,
  DraftOrderInput as AdminDraftOrderInput,
} from "../types/admin.types";
import { call, throwOnUserErrors } from "./client.server";

const quoteTag = (quoteId: string) => `vendora-quote-${quoteId}`;

// A CompanyAddress as VendoraCompanyLocation returns it.
type CompanyAddress = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  zip?: string | null;
  countryCode: CountryCode;
  zoneCode?: string | null;
  companyName?: string | null;
  phone?: string | null;
  recipient?: string | null;
} | null;

// CompanyAddress → MailingAddressInput (B-2). The recipient is split into first and last name.
const toMailingAddress = (address: CompanyAddress | undefined) => {
  if (!address) return undefined;
  const [firstName, ...rest] = (address.recipient ?? "").trim().split(/\s+/);
  return {
    address1: address.address1 ?? undefined,
    address2: address.address2 ?? undefined,
    city: address.city ?? undefined,
    zip: address.zip ?? undefined,
    countryCode: address.countryCode,
    provinceCode: address.zoneCode ?? undefined,
    company: address.companyName ?? undefined,
    phone: address.phone ?? undefined,
    firstName: firstName || undefined,
    lastName: rest.join(" ") || undefined,
  };
};

type DraftInputSource = {
  quote: {
    id: string;
    number: number;
    currencyCode: string;
    companyId: string;
    companyLocationId: string;
    companyContactId: string;
    expiresAt: Date | null;
    poNumber: string | null; // M9.3
  };
  version: {
    versionNumber: number;
    quoteDiscountPct: Money | null;
    lines: {
      variantId: string | null; // null = custom line (M9.2)
      titleSnapshot: string;
      quantity: number;
      catalogPrice: Money;
      overridePrice: Money | null;
      discountPct: Money | null;
    }[];
  };
  location: { shippingAddress?: CompanyAddress; billingAddress?: CompanyAddress };
  shop: { quotePrefix: string; reserveInventory: boolean };
};

// The DraftOrderInput for one quote version. Every line carries the quote's unit price (catalog
// price incl. price breaks as priced when saved, or the override), plus the discounts.
const draftOrderInput = ({ quote, version, location, shop }: DraftInputSource) => {
  const label = `${shop.quotePrefix}${quote.number}`;
  const percent = (value: Money, title: string) => ({
    // Codegen enums are type-only (ambient .d.ts), so the wire value is asserted.
    valueType: "PERCENTAGE" as DraftOrderAppliedDiscountType,
    value: value.toNumber(),
    title,
  });
  return {
    purchasingEntity: {
      purchasingCompany: {
        companyId: quote.companyId,
        companyLocationId: quote.companyLocationId,
        companyContactId: quote.companyContactId,
      },
    },
    lineItems: version.lines.map((line) => {
      // Always the quote's unit price: Shopify's live price can drift after approval (exchange rates,
      // catalog edits), and the customer must pay what was approved.
      const unitPrice = {
        amount: toShopifyAmount(line.overridePrice ?? line.catalogPrice, quote.currencyCode),
        currencyCode: quote.currencyCode as CurrencyCode,
      };
      const discount = line.discountPct &&
        !line.discountPct.isZero() && { appliedDiscount: percent(line.discountPct, "Quote discount") };
      // A custom line (freight, fee, service) becomes a custom line item with its own title and price.
      return line.variantId
        ? { variantId: line.variantId, quantity: line.quantity, priceOverride: unitPrice, ...discount }
        : { title: line.titleSnapshot, quantity: line.quantity, originalUnitPriceWithCurrency: unitPrice, ...discount };
    }),
    ...(version.quoteDiscountPct &&
      !version.quoteDiscountPct.isZero() && {
        appliedDiscount: percent(version.quoteDiscountPct, `Quote ${label}`),
      }),
    shippingAddress: toMailingAddress(location.shippingAddress),
    billingAddress: toMailingAddress(location.billingAddress ?? location.shippingAddress),
    note: `Vendora ${label} v${version.versionNumber}`,
    poNumber: quote.poNumber, // null clears one removed in Vendora
    tags: [quoteTag(quote.id)],
    ...(shop.reserveInventory &&
      quote.expiresAt && { reserveInventoryUntil: quote.expiresAt.toISOString() }),
  };
};

// Takes Shopify's full input type: the onboarding connection test sends a custom line, not a quote.
const createDraftOrder = async (admin: AdminApiContext, input: AdminDraftOrderInput) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      mutation VendoraDraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) { draftOrder { id name updatedAt } userErrors { field message } }
      }`,
      { variables: { input } },
    ),
  );
  const { data } = await response.json();
  throwOnUserErrors(data?.draftOrderCreate?.userErrors);
  const draftOrder = data?.draftOrderCreate?.draftOrder;
  if (!draftOrder) throw new Error("draftOrderCreate returned no draft order");
  return draftOrder;
};

// Fields left out of `input` stay as they are (M9.3 sends only the PO number).
const updateDraftOrder = async (admin: AdminApiContext, id: string, input: AdminDraftOrderInput) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      mutation VendoraDraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
        draftOrderUpdate(id: $id, input: $input) { draftOrder { id name updatedAt } userErrors { field message } }
      }`,
      { variables: { id, input } },
    ),
  );
  const { data } = await response.json();
  throwOnUserErrors(data?.draftOrderUpdate?.userErrors);
  const draftOrder = data?.draftOrderUpdate?.draftOrder;
  if (!draftOrder) throw new Error("draftOrderUpdate returned no draft order");
  return draftOrder;
};

const deleteDraftOrder = async (admin: AdminApiContext, id: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      mutation VendoraDraftOrderDelete($input: DraftOrderDeleteInput!) {
        draftOrderDelete(input: $input) { deletedId userErrors { field message } }
      }`,
      { variables: { input: { id } } },
    ),
  );
  const { data } = await response.json();
  throwOnUserErrors(data?.draftOrderDelete?.userErrors);
};

// Every draft order carrying the quote's tag (normally 0 or 1).
const findDraftOrdersByTag = async (admin: AdminApiContext, quoteId: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraDraftOrderByTag($query: String!) {
        draftOrders(first: 5, query: $query) {
          nodes { id status purchasingEntity { ... on PurchasingCompany { company { id } location { id } } } }
        }
      }`,
      { variables: { query: `tag:'${quoteTag(quoteId)}'` } },
    ),
  );
  const { data } = await response.json();
  return data?.draftOrders.nodes ?? [];
};

const getDraftOrder = async (admin: AdminApiContext, id: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraDraftOrder($id: ID!) {
        draftOrder(id: $id) {
          id status updatedAt invoiceSentAt invoiceUrl
          subtotalPriceSet { presentmentMoney { amount currencyCode } }
        }
      }`,
      { variables: { id } },
    ),
  );
  const { data } = await response.json();
  return data?.draftOrder ?? null;
};

// A draft order made outside Vendora (e.g. a B2B checkout submitted for review, M3.5).
const getSubmittedDraft = async (admin: AdminApiContext, id: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraSubmittedDraft($id: ID!) {
        draftOrder(id: $id) {
          id tags
          lineItems(first: 250) { nodes { quantity variant { id } } }
          purchasingEntity { ... on PurchasingCompany { company { id } location { id } contact { id customer { id } } } }
        }
      }`,
      { variables: { id } },
    ),
  );
  const { data } = await response.json();
  return data?.draftOrder ?? null;
};

const addDraftTags = async (admin: AdminApiContext, id: string, tags: string[]) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      mutation VendoraTagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
      }`,
      { variables: { id, tags } },
    ),
  );
  const { data } = await response.json();
  throwOnUserErrors(data?.tagsAdd?.userErrors);
};

// TAG_COLLISION → "Create a new draft order": our tag comes off the other company's draft (M4.2).
const removeDraftTags = async (admin: AdminApiContext, id: string, tags: string[]) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      mutation VendoraTagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
      }`,
      { variables: { id, tags } },
    ),
  );
  const { data } = await response.json();
  throwOnUserErrors(data?.tagsRemove?.userErrors);
};

// The nightly reconcile (M4.3): state, order and lines, to catch webhooks we missed.
const getDraftForReconcile = async (admin: AdminApiContext, id: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraReconcileDraft($id: ID!) {
        draftOrder(id: $id) {
          id status updatedAt
          order { id }
          lineItems(first: 250) { nodes { title quantity variant { id } } }
        }
      }`,
      { variables: { id } },
    ),
  );
  const { data } = await response.json();
  return data?.draftOrder ?? null;
};

// What the quote page shows about the draft order: Shopify's final totals and the order.
// Needs read_orders (order); kept apart from getDraftOrder so syncing never depends on it.
const getDraftOrderSummary = async (admin: AdminApiContext, id: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraDraftOrderSummary($id: ID!) {
        draftOrder(id: $id) {
          id status invoiceSentAt invoiceUrl
          subtotalPriceSet { presentmentMoney { amount currencyCode } }
          totalTaxSet { presentmentMoney { amount } }
          totalPriceSet { presentmentMoney { amount } }
          order { id name }
        }
      }`,
      { variables: { id } },
    ),
  );
  const { data } = await response.json();
  return data?.draftOrder ?? null;
};

const sendInvoice = async (
  admin: AdminApiContext,
  id: string,
  email: { to: string; subject: string; customMessage: string },
) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      mutation VendoraInvoiceSend($id: ID!, $email: EmailInput) {
        draftOrderInvoiceSend(id: $id, email: $email) { draftOrder { id invoiceSentAt invoiceUrl } userErrors { field message } }
      }`,
      { variables: { id, email } },
    ),
  );
  const { data } = await response.json();
  throwOnUserErrors(data?.draftOrderInvoiceSend?.userErrors);
  return data?.draftOrderInvoiceSend?.draftOrder?.invoiceUrl ?? null;
};

export {
  addDraftTags,
  createDraftOrder,
  deleteDraftOrder,
  draftOrderInput,
  findDraftOrdersByTag,
  getDraftOrder,
  getDraftForReconcile,
  getDraftOrderSummary,
  getSubmittedDraft,
  quoteTag,
  removeDraftTags,
  sendInvoice,
  toMailingAddress,
  updateDraftOrder,
};
export type { CompanyAddress, DraftInputSource };
