import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { useMemo } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { createI18n, pickLocale } from "../lib/i18n";
import { getActor } from "../models/actor.server";
import { getShop, upsertShopOnInstall } from "../models/shop.server";

// Records the staff member on every admin page load. Child loaders that need the role call getActor too
// (the upsert is safe to run twice at once, see staff.server.test.ts).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);

  // Backfill for shops installed before afterAuth existed, or if afterAuth failed.
  const shop = await getShop(actor.shop);
  // !shop.name: shops installed before M3.3 get their name for email footers.
  if (!shop || shop.uninstalledAt || !shop.name) await upsertShopOnInstall(actor.admin, actor.shop);

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    // Admin language: ?locale= on the first load, else the staff member's saved locale.
    locale: pickLocale(new URL(request.url).searchParams.get("locale") ?? actor.locale),
  };
};

export default function App() {
  const { apiKey, locale } = useLoaderData<typeof loader>();
  const i18n = useMemo(() => createI18n(locale), [locale]);

  return (
    <AppProvider apiKey={apiKey}>
      <I18nextProvider i18n={i18n}>
        <Nav />
        <Outlet />
      </I18nextProvider>
    </AppProvider>
  );
}

function Nav() {
  const { t } = useTranslation();
  return (
    <s-app-nav>
      <s-link href="/app">{t("nav.dashboard")}</s-link>
      <s-link href="/app/quotes">{t("nav.quotes")}</s-link>
      <s-link href="/app/settings">{t("nav.settings")}</s-link>
    </s-app-nav>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
