import { logger } from "../lib/logger.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { QuantityRule } from "../models/pricing";
import { ShopifyDenied, call } from "./client.server";

type VariantPrice = {
  id: string;
  sku: string | null;
  title: string;
  productId: string;
  productTitle: string;
  status: string;
  isGiftCard: boolean;
  tracked: boolean;
  inventoryQuantity: number | null;
  price: string; // the price at the company location: its catalog, else the base price converted to its market
  currencyCode: string;
  quantityRule: QuantityRule;
  priceBreaks: { minimumQuantity: number; price: string }[];
};

const BATCH = 100;

// The location's market comes from its address country. Without it, contextualPricing for a
// location with no catalog returns the shop-currency base price instead of the market price
// the draft order charges (e.g. 749.95 USD instead of 1010.00 CAD for Snowdevil).
const getLocationCountry = async (admin: AdminApiContext, companyLocationId: string) => {
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraLocationCountry($id: ID!) {
        companyLocation(id: $id) {
          shippingAddress { countryCode }
          billingAddress { countryCode }
        }
      }`,
      { variables: { id: companyLocationId } },
    ),
  );
  const { data } = await response.json();
  const location = data?.companyLocation;
  return location?.shippingAddress?.countryCode ?? location?.billingAddress?.countryCode ?? null;
};

// Prices as Shopify will charge them at this company location. Deleted variants are missing from the map.
const getVariantPrices = async (
  admin: AdminApiContext,
  variantIds: string[],
  companyLocationId: string,
): Promise<Map<string, VariantPrice>> => {
  const prices = new Map<string, VariantPrice>();
  if (variantIds.length === 0) return prices;
  const country = await getLocationCountry(admin, companyLocationId);
  if (!country) logger.warn({ companyLocationId }, "company location has no address country");
  for (let i = 0; i < variantIds.length; i += BATCH) {
    const ids = variantIds.slice(i, i + BATCH);
    const response = await call(() =>
      admin.graphql(
        `#graphql
        query VendoraVariantPrices($ids: [ID!]!, $companyLocationId: ID!, $country: CountryCode) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              sku
              title
              inventoryQuantity
              inventoryItem { tracked }
              product { id title status isGiftCard }
              contextualPricing(context: { companyLocationId: $companyLocationId, country: $country }) {
                price { amount currencyCode }
                quantityRule { minimum maximum increment }
                quantityPriceBreaks(first: 10) { nodes { minimumQuantity price { amount currencyCode } } }
              }
            }
          }
        }`,
        { variables: { ids, companyLocationId, country } },
      ),
    );
    const { data } = await response.json();
    for (const node of data?.nodes ?? []) {
      if (!node || !("contextualPricing" in node)) continue; // deleted variant → null node
      const contextual = node.contextualPricing;
      prices.set(node.id, {
        id: node.id,
        sku: node.sku ?? null,
        title: node.title,
        productId: node.product.id,
        productTitle: node.product.title,
        status: node.product.status,
        isGiftCard: node.product.isGiftCard,
        tracked: node.inventoryItem.tracked,
        inventoryQuantity: node.inventoryQuantity ?? null,
        price: contextual.price.amount,
        currencyCode: contextual.price.currencyCode,
        quantityRule: { ...contextual.quantityRule, maximum: contextual.quantityRule.maximum ?? null },
        priceBreaks: contextual.quantityPriceBreaks.nodes.map((priceBreak) => ({
          minimumQuantity: priceBreak.minimumQuantity,
          price: priceBreak.price.amount,
        })),
      });
    }
  }
  return prices;
};

// Variants whose SKU matches one of `skus` (≤ 50 per call). Shopify's search may also return
// partial matches, so callers compare SKUs exactly; first: 250 leaves room for those.
const findVariantsBySku = async (admin: AdminApiContext, skus: string[]) => {
  if (skus.length === 0) return [];
  const query = skus.map((sku) => `sku:"${sku.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" OR ");
  const response = await call(() =>
    admin.graphql(
      `#graphql
      query VendoraVariantsBySku($query: String!) {
        productVariants(first: 250, query: $query) { nodes { id sku } }
      }`,
      { variables: { query } },
    ),
  );
  const { data } = await response.json();
  if (!data?.productVariants) throw new Error("Shopify returned no product variants");
  return data.productVariants.nodes;
};

// M10.2: unit costs by variant, as { amount, currencyCode } (always the shop's currency); a variant
// with no cost entered is missing from the map. Needs the staff member's "View product costs"
// permission: throws ShopifyDenied without it (callers fall back to the offline token).
const getUnitCosts = async (admin: AdminApiContext, variantIds: string[]) => {
  const costs = new Map<string, { amount: string; currencyCode: string }>();
  for (let i = 0; i < variantIds.length; i += BATCH) {
    const response = await call(() =>
      admin.graphql(
        `#graphql
        query VendoraUnitCosts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              inventoryItem { unitCost { amount currencyCode } }
            }
          }
        }`,
        { variables: { ids: variantIds.slice(i, i + BATCH) } },
      ),
    );
    const { data } = await response.json();
    for (const node of data?.nodes ?? []) {
      if (!node || !("inventoryItem" in node)) continue;
      const cost = node.inventoryItem.unitCost;
      if (cost) costs.set(node.id, { amount: cost.amount, currencyCode: cost.currencyCode });
    }
  }
  return costs;
};

// M10.2: may this staff member see costs? Shopify decides ("View product costs"), so ask with their
// online token. Cached per staff member for 10 minutes.
// ponytail: in memory, per process, like companyNames; a revoked permission shows costs ≤ 10 min longer.
const COST_ACCESS_TTL_MS = 10 * 60_000;
const costAccess = new Map<string, { allowed: boolean; until: number }>(); // key: `${shop} ${userId}`

const canViewCosts = async (admin: AdminApiContext, shop: string, userId: string, now = Date.now()) => {
  const key = `${shop} ${userId}`;
  const hit = costAccess.get(key);
  if (hit && hit.until > now) return hit.allowed;
  let allowed = true;
  try {
    await call(() =>
      admin.graphql(
        `#graphql
        query VendoraCanViewCosts {
          productVariants(first: 1) { nodes { inventoryItem { unitCost { amount } } } }
        }`,
      ),
    );
  } catch (error) {
    if (!(error instanceof ShopifyDenied)) throw error;
    allowed = false;
    logger.info({ shop, userId }, "staff member can't view product costs");
  }
  costAccess.set(key, { allowed, until: now + COST_ACCESS_TTL_MS });
  return allowed;
};

export { canViewCosts, findVariantsBySku, getUnitCosts, getVariantPrices };
export type { VariantPrice };
