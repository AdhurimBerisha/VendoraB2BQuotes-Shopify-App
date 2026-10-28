import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const fetchShopInfo = async (admin: AdminApiContext) => {
  const response = await admin.graphql(
    `#graphql
    query VendoraShopInfo {
      shop { id ianaTimezone currencyCode }
    }`,
  );
  const { data } = await response.json();
  if (!data?.shop) throw new Error("Shopify returned no shop info");
  return data.shop;
};

export { fetchShopInfo };
