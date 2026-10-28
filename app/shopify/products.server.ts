import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { call } from "./client.server";

// ponytail: `price` is the shop-currency list price; M2.3 replaces it with the
// company location's catalog price (contextualPricing).
const getVariant = async (admin: AdminApiContext, id: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraVariant($id: ID!) {
        productVariant(id: $id) { id title price sku product { id title } }
      }`,
      { variables: { id } },
    ),
  );
  const { data } = await response.json();
  return data?.productVariant ?? null;
};

export { getVariant };
