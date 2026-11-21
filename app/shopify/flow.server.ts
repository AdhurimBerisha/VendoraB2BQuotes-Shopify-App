import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { call, throwOnUserErrors } from "./client.server";

// M9.4: starts the merchant's workflows that use this trigger. `payload` must have every field the
// trigger's shopify.extension.toml defines (custom fields by key, references by payload key).
const sendFlowTrigger = async (admin: AdminApiContext, handle: string, payload: Record<string, string | number>) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      mutation VendoraFlowTrigger($handle: String!, $payload: JSON!) {
        flowTriggerReceive(handle: $handle, payload: $payload) { userErrors { field message } }
      }`,
      { variables: { handle, payload } },
    ),
  );
  const { data } = await response.json();
  throwOnUserErrors(data?.flowTriggerReceive?.userErrors);
};

export { sendFlowTrigger };
