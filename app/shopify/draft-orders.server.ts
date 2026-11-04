import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { type Money, toShopifyAmount } from "../lib/money";
import type { CountryCode, CurrencyCode, DraftOrderAppliedDiscountType } from "../types/admin.types";
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
  };
  version: {
    versionNumber: number;
    quoteDiscountPct: Money | null;
    lines: { variantId: string; quantity: number; overridePrice: Money | null; discountPct: Money | null }[];
  };
  location: { shippingAddress?: CompanyAddress; billingAddress?: CompanyAddress };
  shop: { quotePrefix: string; reserveInventory: boolean };
};

// The DraftOrderInput for one quote version. Catalog prices and price breaks come from the
// purchasing entity in Shopify; only overrides and discounts are sent explicitly.
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
    lineItems: version.lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      ...(line.overridePrice && {
        priceOverride: {
          amount: toShopifyAmount(line.overridePrice, quote.currencyCode),
          currencyCode: quote.currencyCode as CurrencyCode,
        },
      }),
      ...(line.discountPct &&
        !line.discountPct.isZero() && { appliedDiscount: percent(line.discountPct, "Quote discount") }),
    })),
    ...(version.quoteDiscountPct &&
      !version.quoteDiscountPct.isZero() && {
        appliedDiscount: percent(version.quoteDiscountPct, `Quote ${label}`),
      }),
    shippingAddress: toMailingAddress(location.shippingAddress),
    billingAddress: toMailingAddress(location.billingAddress ?? location.shippingAddress),
    note: `Vendora ${label} v${version.versionNumber}`,
    tags: [quoteTag(quote.id)],
    ...(shop.reserveInventory &&
      quote.expiresAt && { reserveInventoryUntil: quote.expiresAt.toISOString() }),
  };
};
type DraftOrderInput = ReturnType<typeof draftOrderInput>;

const createDraftOrder = async (admin: AdminApiContext, input: DraftOrderInput) => {
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

const updateDraftOrder = async (admin: AdminApiContext, id: string, input: DraftOrderInput) => {
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
  getDraftOrderSummary,
  getSubmittedDraft,
  quoteTag,
  sendInvoice,
  toMailingAddress,
  updateDraftOrder,
};
export type { CompanyAddress, DraftInputSource };
