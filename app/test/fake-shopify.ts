import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { graphqlError, httpError, networkError } from "./fake-errors";

// What failNext can make an operation do (M4.1). The first five throw before anything happens;
// userErrors rejects the input; crashAfterCommit applies the change, then loses the response.
type Fault = "network" | "http500" | "http429" | "throttled" | "accessDenied" | "userErrors" | "crashAfterCommit";
const THROWS: Partial<Record<Fault, () => Error>> = {
  network: networkError,
  http500: () => httpError(500),
  http429: () => httpError(429),
  throttled: () => graphqlError("THROTTLED"),
  accessDenied: () => graphqlError("ACCESS_DENIED"),
};

// What companyLocation(id) returns: Snowdevil-like, with a main contact.
const FAKE_LOCATION = {
  id: "gid://shopify/CompanyLocation/1",
  name: "Main",
  currency: "USD",
  shippingAddress: {
    address1: "1 Ship St",
    city: "Toronto",
    zip: "M5V 1A1",
    countryCode: "CA",
    zoneCode: "ON",
    companyName: "Fake Co",
    recipient: "Ada Lovelace King",
  },
  billingAddress: null,
  company: {
    id: "gid://shopify/Company/1",
    name: "Fake Co",
    mainContact: { id: "gid://shopify/CompanyContact/1", customer: { id: "gid://shopify/Customer/1" } },
  },
};

type FakeVariant = {
  price: string;
  sku?: string;
  isGiftCard?: boolean;
  currencyCode?: string;
  status?: string;
  quantityRule?: { minimum: number; maximum: number | null; increment: number };
  priceBreaks?: { minimumQuantity: number; price: string }[];
  inventoryQuantity?: number | null;
};

// The VendoraVariantPrices node for a variant at the company location.
const variantNode = (id: string, variant: FakeVariant) => {
  const n = id.split("/").pop();
  const currencyCode = variant.currencyCode ?? "USD";
  return {
    id,
    sku: variant.sku ?? `SKU-${n}`,
    title: "Default Title",
    inventoryQuantity: variant.inventoryQuantity ?? null,
    inventoryItem: { tracked: variant.inventoryQuantity != null },
    product: { id: `gid://shopify/Product/${n}`, title: `Product ${n}`, status: variant.status ?? "ACTIVE", isGiftCard: variant.isGiftCard ?? false },
    contextualPricing: {
      price: { amount: variant.price, currencyCode },
      quantityRule: variant.quantityRule ?? { minimum: 1, maximum: null, increment: 1 },
      quantityPriceBreaks: {
        nodes: (variant.priceBreaks ?? []).map((b) => ({
          minimumQuantity: b.minimumQuantity,
          price: { amount: b.price, currencyCode },
        })),
      },
    },
  };
};

type FakeDraft = {
  id: string;
  tags: string[];
  companyId: string;
  locationId: string;
  input: Record<string, unknown>;
  invoiceSentAt: string | null;
  lines?: { variantId: string | null; quantity: number }[]; // a draft made outside Vendora (M3.5), or edited in Shopify
  status?: "OPEN" | "INVOICE_SENT" | "COMPLETED";
  orderId?: string;
};

const userErrorsJson = (field: string, messages: string[]) =>
  Response.json({
    data: { [field]: { draftOrder: null, deletedId: null, userErrors: messages.map((message) => ({ field: null, message })) } },
  });

// Fake Shopify Admin client: keeps its own draft orders so tag search, updates and invoices
// behave like the real API, and counts calls. failNext(op, ...faults) makes the next calls of an
// operation (by its GraphQL name, e.g. "VendoraDraftOrderCreate") fail, one fault per call.
// `variants` (keyed by gid) answers price lookups; a gid not listed behaves like a deleted variant.
// `subtotal` is what Shopify reports back for every draft order (testQuote's version total is 0).
const fakeShopify = ({
  location = FAKE_LOCATION as object,
  variants = {} as Record<string, FakeVariant>,
  subtotal = "0.00",
  contactEmail = "buyer@example.com" as string | null,
  buyerLocations = ["gid://shopify/CompanyLocation/1"], // where the logged-in buyer holds a role (M3.5)
} = {}) => {
  const drafts: FakeDraft[] = [];
  const calls = { create: 0, update: 0, delete: 0, invoice: 0, skuSearch: 0 };
  const opCalls: Record<string, number> = {};
  const faults: Record<string, Fault[]> = {};
  const find = (id: string) => drafts.find((draft) => draft.id === id);
  const now = () => new Date().toISOString();

  const handle = async (
    query: string,
    // Optional like the real client: queries without variables pass no second argument.
    { variables }: { variables: any } = { variables: {} }, // eslint-disable-line @typescript-eslint/no-explicit-any
  ) => {
    if (query.includes("VendoraDraftOrderCreate")) {
      calls.create++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const { purchasingCompany } = variables.input.purchasingEntity;
      const draft: FakeDraft = {
        id: `gid://shopify/DraftOrder/${drafts.length + 1}`,
        tags: variables.input.tags,
        companyId: purchasingCompany.companyId,
        locationId: purchasingCompany.companyLocationId,
        input: variables.input,
        invoiceSentAt: null,
      };
      drafts.push(draft);
      return Response.json({
        data: { draftOrderCreate: { draftOrder: { id: draft.id, updatedAt: now() }, userErrors: [] } },
      });
    }
    if (query.includes("VendoraDraftOrderUpdate")) {
      calls.update++;
      const draft = find(variables.id);
      if (!draft) return userErrorsJson("draftOrderUpdate", ["Draft order does not exist"]);
      draft.input = variables.input;
      draft.tags = variables.input.tags;
      return Response.json({
        data: { draftOrderUpdate: { draftOrder: { id: draft.id, updatedAt: now() }, userErrors: [] } },
      });
    }
    if (query.includes("VendoraDraftOrderDelete")) {
      calls.delete++;
      const index = drafts.findIndex((draft) => draft.id === variables.input.id);
      if (index === -1) return userErrorsJson("draftOrderDelete", ["Draft order does not exist"]);
      drafts.splice(index, 1);
      return Response.json({ data: { draftOrderDelete: { deletedId: variables.input.id, userErrors: [] } } });
    }
    if (query.includes("VendoraDraftOrderByTag")) {
      const tag = /tag:'(.+)'/.exec(variables.query)![1];
      const nodes = drafts
        .filter((draft) => draft.tags.includes(tag))
        .map((draft) => ({
          id: draft.id,
          status: "OPEN",
          purchasingEntity: { company: { id: draft.companyId }, location: { id: draft.locationId } },
        }));
      return Response.json({ data: { draftOrders: { nodes } } });
    }
    if (query.includes("VendoraDraftOrder(")) {
      const draft = find(variables.id);
      return Response.json({
        data: {
          draftOrder: draft && {
            id: draft.id,
            status: "OPEN",
            updatedAt: now(),
            invoiceSentAt: draft.invoiceSentAt,
            subtotalPriceSet: { presentmentMoney: { amount: subtotal, currencyCode: "USD" } },
          },
        },
      });
    }
    if (query.includes("VendoraReconcileDraft")) {
      const draft = find(variables.id);
      const inputLines = (draft?.input.lineItems as { variantId: string; quantity: number }[] | undefined) ?? [];
      return Response.json({
        data: {
          draftOrder: draft && {
            id: draft.id,
            status: draft.status ?? (draft.invoiceSentAt ? "INVOICE_SENT" : "OPEN"),
            updatedAt: now(),
            order: draft.orderId ? { id: draft.orderId } : null,
            lineItems: {
              nodes: (draft.lines ?? inputLines).map((line) => ({
                quantity: line.quantity,
                variant: line.variantId ? { id: line.variantId } : null,
              })),
            },
          },
        },
      });
    }
    if (query.includes("VendoraSubmittedDraft")) {
      const draft = find(variables.id);
      return Response.json({
        data: {
          draftOrder: draft && {
            id: draft.id,
            tags: draft.tags,
            lineItems: {
              nodes: (draft.lines ?? []).map((line) => ({
                quantity: line.quantity,
                variant: line.variantId ? { id: line.variantId } : null,
              })),
            },
            // An empty companyId stands for a consumer (non-company) draft order.
            purchasingEntity: draft.companyId
              ? { company: { id: draft.companyId }, location: { id: draft.locationId }, contact: null }
              : { id: "gid://shopify/Customer/9" },
          },
        },
      });
    }
    if (query.includes("VendoraBuyerLocations")) {
      const roles = buyerLocations.map((id) => ({ companyLocation: { id } }));
      const profiles = [{ id: "gid://shopify/CompanyContact/7", roleAssignments: { nodes: roles } }];
      return Response.json({ data: { customer: { companyContactProfiles: profiles } } });
    }
    if (query.includes("VendoraTagsRemove")) {
      const draft = find(variables.id);
      if (!draft) return Response.json({ data: { tagsRemove: { userErrors: [{ field: null, message: "Not found" }] } } });
      draft.tags = draft.tags.filter((tag) => !variables.tags.includes(tag));
      return Response.json({ data: { tagsRemove: { userErrors: [] } } });
    }
    if (query.includes("VendoraTagsAdd")) {
      const draft = find(variables.id);
      if (!draft) return Response.json({ data: { tagsAdd: { userErrors: [{ field: null, message: "Not found" }] } } });
      draft.tags = [...new Set([...draft.tags, ...variables.tags])];
      return Response.json({ data: { tagsAdd: { userErrors: [] } } });
    }
    if (query.includes("VendoraInvoiceSend")) {
      calls.invoice++;
      const draft = find(variables.id);
      if (!draft) return userErrorsJson("draftOrderInvoiceSend", ["Draft order does not exist"]);
      draft.invoiceSentAt = now();
      return Response.json({
        data: { draftOrderInvoiceSend: { draftOrder: { id: draft.id, invoiceSentAt: draft.invoiceSentAt }, userErrors: [] } },
      });
    }
    if (query.includes("VendoraShopInfo")) {
      return Response.json({
        data: { shop: { id: "gid://shopify/Shop/1", name: "Fake Shop", ianaTimezone: "UTC", currencyCode: "USD" } },
      });
    }
    if (query.includes("VendoraContact")) {
      const customer = { id: "gid://shopify/Customer/1", defaultEmailAddress: contactEmail ? { emailAddress: contactEmail } : null };
      return Response.json({ data: { companyContact: { id: variables.id, customer } } });
    }
    if (query.includes("VendoraVariantsBySku")) {
      calls.skuSearch++;
      // Case-insensitive exact match (Shopify may also return partial matches; callers filter).
      const terms = new Set(
        [...(variables.query as string).matchAll(/sku:"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].toLowerCase()),
      );
      const nodes = Object.entries(variants)
        .map(([id, variant]) => ({ id, sku: variantNode(id, variant).sku }))
        .filter(({ sku }) => terms.has(sku.toLowerCase()));
      return Response.json({ data: { productVariants: { nodes } } });
    }
    if (query.includes("VendoraVariantPrices")) {
      // Without the country, Shopify ignores the location's market (see getLocationCountry).
      if (!variables.country) throw new Error("VendoraVariantPrices called without a country");
      const nodes = (variables.ids as string[]).map((id) =>
        variants[id] ? variantNode(id, variants[id]) : null,
      );
      return Response.json({ data: { nodes } });
    }
    if (query.includes("VendoraCompanyNames")) {
      const nodes = (variables.ids as string[]).map((id) => ({ id, name: `Company ${id.split("/").pop()}` }));
      return Response.json({ data: { nodes } });
    }
    if (query.includes("VendoraCompanySearch")) {
      // One company that can buy. failNext("VendoraCompanySearch", "accessDenied") = the store lost B2B (M5.3).
      const company = {
        id: "gid://shopify/Company/1",
        name: "Fake Co",
        mainContact: { id: "gid://shopify/CompanyContact/1" },
        locations: { nodes: [{ id: "gid://shopify/CompanyLocation/1", name: "Main", currency: "USD" }] },
      };
      return Response.json({ data: { companies: { nodes: [company], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes("companyLocation(")) {
      return Response.json({ data: { companyLocation: location } });
    }
    throw new Error(`Unexpected query: ${query}`);
  };

  const graphql: typeof handle = async (query, options) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
    opCalls[op] = (opCalls[op] ?? 0) + 1;
    const fault = faults[op]?.shift();
    const thrown = fault && THROWS[fault];
    if (thrown) throw thrown();
    if (fault === "userErrors") {
      if (op === "VendoraDraftOrderCreate") calls.create++;
      // The mutation's root field, e.g. draftOrderCreate.
      return userErrorsJson(/\{\s*(\w+)\(/.exec(query)?.[1] ?? op, ["Variant is invalid"]);
    }
    const response = await handle(query, options);
    if (fault === "crashAfterCommit") throw networkError(); // Shopify did it; we never heard back
    return response;
  };

  // A draft order that already exists in Shopify (e.g. made by someone else, or by a crashed attempt).
  const seedDraft = (draft: Pick<FakeDraft, "tags" | "companyId" | "locationId" | "lines">) => {
    const seeded: FakeDraft = { id: `gid://shopify/DraftOrder/${drafts.length + 1}`, input: {}, invoiceSentAt: null, ...draft };
    drafts.push(seeded);
    return seeded;
  };

  return {
    admin: { graphql } as unknown as AdminApiContext,
    drafts,
    calls,
    creates: () => calls.create,
    callsOf: (op: string) => opCalls[op] ?? 0,
    // Things done in Shopify that Vendora only hears about by webhook (or the nightly reconcile).
    completeDraft: (id: string, orderId = "gid://shopify/Order/1") => {
      const draft = find(id);
      if (!draft) throw new Error(`no draft ${id}`);
      Object.assign(draft, { status: "COMPLETED", orderId });
    },
    editDraftInShopify: (id: string, lines: { variantId: string; quantity: number }[]) => {
      const draft = find(id);
      if (!draft) throw new Error(`no draft ${id}`);
      draft.lines = lines;
    },
    deleteDraftInShopify: (id: string) => {
      const index = drafts.findIndex((draft) => draft.id === id);
      if (index !== -1) drafts.splice(index, 1);
    },
    failNext: (op: string, ...next: Fault[]) => {
      faults[op] = [...(faults[op] ?? []), ...next];
    },
    seedDraft,
  };
};

export { FAKE_LOCATION, fakeShopify };
export type { Fault, FakeVariant };
