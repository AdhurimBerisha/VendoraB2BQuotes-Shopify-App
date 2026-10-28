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

// Fake Shopify Admin client: counts draftOrderCreate calls and keeps its own draft
// orders so tag search behaves like the real API. Grows into the fault-injection fake in M4.1.
const fakeShopify = ({ crashAfterCreate = false, location = FAKE_LOCATION as object } = {}) => {
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
