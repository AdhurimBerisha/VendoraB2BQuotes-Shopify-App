import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { getActor } from "../models/actor.server";
import { getShop, upsertShopOnInstall } from "../models/shop.server";

// Child loaders run in parallel with this one, so only this loader records the staff member.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);

  // Backfill for shops installed before afterAuth existed, or if afterAuth failed.
  const shop = await getShop(actor.shop);
  if (!shop || shop.uninstalledAt) await upsertShopOnInstall(actor.admin, actor.shop);

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    staff: { name: actor.name, role: actor.role, locale: actor.locale },
  };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Quotes</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
