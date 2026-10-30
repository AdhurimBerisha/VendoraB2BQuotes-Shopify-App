import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { getActor } from "../models/actor.server";
import { can } from "../models/permissions";
import { getShop, upsertShopOnInstall } from "../models/shop.server";

// Records the staff member on every admin page load. Child loaders that need the role call getActor too
// (the upsert is safe to run twice at once, see staff.server.test.ts).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);

  // Backfill for shops installed before afterAuth existed, or if afterAuth failed.
  const shop = await getShop(actor.shop);
  if (!shop || shop.uninstalledAt) await upsertShopOnInstall(actor.admin, actor.shop);

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    staff: { name: actor.name, role: actor.role, locale: actor.locale },
    canManageSettings: can(actor, "settings.manage"),
  };
};

export default function App() {
  const { apiKey, canManageSettings } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Quotes</s-link>
        {canManageSettings && <s-link href="/app/settings">Settings</s-link>}
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
