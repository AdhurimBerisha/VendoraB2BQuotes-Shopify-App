import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { call } from "./client.server";

const getCompanyLocation = async (admin: AdminApiContext, id: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraCompanyLocation($id: ID!) {
        companyLocation(id: $id) {
          id name currency
          company { id name mainContact { id customer { id } } }
          shippingAddress { address1 address2 city zip countryCode zoneCode companyName phone recipient }
          billingAddress { address1 address2 city zip countryCode zoneCode companyName phone recipient }
        }
      }`,
      { variables: { id } },
    ),
  );
  const { data } = await response.json();
  return data?.companyLocation ?? null;
};

const searchCompanies = async (admin: AdminApiContext, query?: string, after?: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraCompanySearch($query: String, $after: String) {
        companies(first: 20, after: $after, query: $query, sortKey: NAME) {
          nodes { id name mainContact { id } locations(first: 50) { nodes { id name currency } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { query: query || null, after: after || null } },
    ),
  );
  const { data } = await response.json();
  if (!data?.companies) throw new Error("Shopify returned no companies");
  return data.companies;
};

const getContact = async (admin: AdminApiContext, id: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraContact($id: ID!) {
        companyContact(id: $id) { id customer { id displayName defaultEmailAddress { emailAddress } } }
      }`,
      { variables: { id } },
    ),
  );
  const { data } = await response.json();
  return data?.companyContact ?? null;
};

// Company names for a page of quotes, in one call. Deleted companies are missing from the map.
const companyNames = async (admin: AdminApiContext, ids: string[]) => {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraCompanyNames($ids: [ID!]!) {
        nodes(ids: $ids) { ... on Company { id name } }
      }`,
      { variables: { ids } },
    ),
  );
  const { data } = await response.json();
  for (const node of data?.nodes ?? []) {
    if (node && "name" in node) names.set(node.id, node.name);
  }
  return names;
};

export { companyNames, getCompanyLocation, getContact, searchCompanies };
