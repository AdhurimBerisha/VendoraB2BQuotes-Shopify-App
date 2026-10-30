import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { QuantityRule } from "../models/pricing";
import { call } from "./client.server";

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
  price: string; // the company location's catalog price (Shopify falls back to the base price itself)
  currencyCode: string;
  quantityRule: QuantityRule;
  priceBreaks: { minimumQuantity: number; price: string }[];
};

const BATCH = 100;

// Prices as Shopify will charge them at this company location. Deleted variants are missing from the map.
const getVariantPrices = async (
  admin: AdminApiContext,
  variantIds: string[],
  companyLocationId: string,
): Promise<Map<string, VariantPrice>> => {
  const prices = new Map<string, VariantPrice>();
  for (let i = 0; i < variantIds.length; i += BATCH) {
    const ids = variantIds.slice(i, i + BATCH);
    const response = await call(() =>
      admin.graphql(
        `#graphql
        query VendoraVariantPrices($ids: [ID!]!, $companyLocationId: ID!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              sku
              title
              inventoryQuantity
              inventoryItem { tracked }
              product { id title status isGiftCard }
              contextualPricing(context: { companyLocationId: $companyLocationId }) {
                price { amount currencyCode }
                quantityRule { minimum maximum increment }
                quantityPriceBreaks(first: 10) { nodes { minimumQuantity price { amount currencyCode } } }
              }
            }
          }
        }`,
        { variables: { ids, companyLocationId } },
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

export { getVariantPrices };
export type { VariantPrice };
