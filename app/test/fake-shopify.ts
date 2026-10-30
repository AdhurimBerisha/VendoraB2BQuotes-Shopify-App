import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// What companyLocation(id) returns: Snowdevil-like, with a main contact.
const FAKE_LOCATION = {
  id: "gid://shopify/CompanyLocation/1",
  name: "Main",
  currency: "USD",
  company: {
    id: "gid://shopify/Company/1",
    name: "Fake Co",
    mainContact: { id: "gid://shopify/CompanyContact/1", customer: { id: "gid://shopify/Customer/1" } },
  },
};

type FakeVariant = {
  price: string;
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
    sku: `SKU-${n}`,
    title: "Default Title",
    inventoryQuantity: variant.inventoryQuantity ?? null,
    inventoryItem: { tracked: variant.inventoryQuantity != null },
    product: { id: `gid://shopify/Product/${n}`, title: `Product ${n}`, status: variant.status ?? "ACTIVE", isGiftCard: false },
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

// Fake Shopify Admin client: counts draftOrderCreate calls and keeps its own draft
// orders so tag search behaves like the real API. Grows into the fault-injection fake in M4.1.
// `variants` (keyed by gid) answers price lookups; a gid not listed behaves like a deleted variant.
const fakeShopify = ({
  crashAfterCreate = false,
  location = FAKE_LOCATION as object,
  variants = {} as Record<string, FakeVariant>,
} = {}) => {
  const drafts: { id: string; tags: string[] }[] = [];
  let creates = 0;
  const graphql = async (
    query: string,
    { variables }: { variables: any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  ) => {
    if (query.includes("draftOrderCreate")) {
      creates++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const id = `gid://shopify/DraftOrder/${drafts.length + 1}`;
      drafts.push({ id, tags: variables.input.tags });
      if (crashAfterCreate) throw new Error("socket hang up");
      return Response.json({
        data: { draftOrderCreate: { draftOrder: { id }, userErrors: [] } },
      });
    }
    if (query.includes("draftOrders")) {
      const tag = /tag:'(.+)'/.exec(variables.query)![1];
      const nodes = drafts.filter((d) => d.tags.includes(tag));
      return Response.json({
        data: { draftOrders: { nodes: nodes.map(({ id }) => ({ id })) } },
      });
    }
    if (query.includes("VendoraVariantPrices")) {
      const nodes = (variables.ids as string[]).map((id) =>
        variants[id] ? variantNode(id, variants[id]) : null,
      );
      return Response.json({ data: { nodes } });
    }
    if (query.includes("companyLocation(")) {
      return Response.json({ data: { companyLocation: location } });
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  return {
    admin: { graphql } as unknown as AdminApiContext,
    drafts,
    creates: () => creates,
  };
};

export { fakeShopify };
export type { FakeVariant };
