import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Fake Shopify Admin client: counts draftOrderCreate calls and keeps its own draft
// orders so tag search behaves like the real API. Grows into the fault-injection fake in M4.1.
const fakeShopify = ({ crashAfterCreate = false } = {}) => {
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
    throw new Error(`Unexpected query: ${query}`);
  };
  return {
    admin: { graphql } as unknown as AdminApiContext,
    drafts,
    creates: () => creates,
  };
};

export { fakeShopify };
