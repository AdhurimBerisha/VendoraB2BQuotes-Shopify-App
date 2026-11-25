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
          buyerExperienceConfiguration {
            paymentTermsTemplate { id name }
            deposit { ... on DepositPercentage { percentage } }
          }
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

// M4.6: names looked up in the last 5 minutes, per shop, so paging and filtering the quote list
// usually skips the Shopify call. A renamed company shows its old name for up to 5 minutes.
// ponytail: in memory, per process; fine until several instances need a shared cache.
const NAME_TTL_MS = 5 * 60_000;
const nameCache = new Map<string, { name: string | null; until: number }>(); // key: `${shop} ${companyId}`

// Company names for a page of quotes, in one call. Deleted companies are missing from the map.
const companyNames = async (admin: AdminApiContext, shop: string, ids: string[], now = Date.now()) => {
  const names = new Map<string, string>();
  const missing: string[] = [];
  for (const id of ids) {
    const hit = nameCache.get(`${shop} ${id}`);
    if (!hit || hit.until <= now) missing.push(id);
    else if (hit.name !== null) names.set(id, hit.name);
  }
  if (missing.length === 0) return names;

  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraCompanyNames($ids: [ID!]!) {
        nodes(ids: $ids) { ... on Company { id name } }
      }`,
      { variables: { ids: missing } },
    ),
  );
  const { data } = await response.json();
  const found = new Map<string, string>();
  for (const node of data?.nodes ?? []) {
    if (node && "name" in node) found.set(node.id, node.name);
  }
  if (nameCache.size > 50_000) {
    for (const [key, entry] of nameCache) if (entry.until <= now) nameCache.delete(key);
  }
  for (const id of missing) {
    const name = found.get(id) ?? null;
    nameCache.set(`${shop} ${id}`, { name, until: now + NAME_TTL_MS });
    if (name !== null) names.set(id, name);
  }
  return names;
};

// The companies a logged-in buyer is a contact of (customer account page, M3.4).
const companyIdsForCustomer = async (admin: AdminApiContext, customerId: string): Promise<string[]> => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraCustomerCompanies($id: ID!) {
        customer(id: $id) { companyContactProfiles { id company { id } } }
      }`,
      { variables: { id: customerId } },
    ),
  );
  const { data } = await response.json();
  return data?.customer?.companyContactProfiles.map((profile) => profile.company.id) ?? [];
};

// The buyer's company contact that may buy for this location (has a role there), or null.
const contactIdForLocation = async (admin: AdminApiContext, customerId: string, locationId: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraBuyerLocations($id: ID!) {
        customer(id: $id) {
          companyContactProfiles { id roleAssignments(first: 100) { nodes { companyLocation { id } } } }
        }
      }`,
      { variables: { id: customerId } },
    ),
  );
  const { data } = await response.json();
  const profile = data?.customer?.companyContactProfiles.find((contact) =>
    contact.roleAssignments.nodes.some((role) => role.companyLocation.id === locationId),
  );
  return profile?.id ?? null;
};

export { companyIdsForCustomer, companyNames, contactIdForLocation, getCompanyLocation, getContact, searchCompanies };
