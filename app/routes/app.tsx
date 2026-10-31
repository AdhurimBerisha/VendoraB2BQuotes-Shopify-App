import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { useMemo } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { createI18n, pickLocale } from "../lib/i18n";
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
    // Admin language: ?locale= on the first load, else the staff member's saved locale.
    locale: pickLocale(new URL(request.url).searchParams.get("locale") ?? actor.locale),
    canManageSettings: can(actor, "settings.manage"),
  };
};

export default function App() {
  const { apiKey, locale, canManageSettings } = useLoaderData<typeof loader>();
  const i18n = useMemo(() => createI18n(locale), [locale]);

  return (
    <AppProvider apiKey={apiKey}>
      <I18nextProvider i18n={i18n}>
        <Nav canManageSettings={canManageSettings} />
        <Outlet />
      </I18nextProvider>
    </AppProvider>
  );
}

function Nav({ canManageSettings }: { canManageSettings: boolean }) {
  const { t } = useTranslation();
  return (
    <s-app-nav>
      <s-link href="/app">{t("nav.dashboard")}</s-link>
      <s-link href="/app/quotes">{t("nav.quotes")}</s-link>
      {canManageSettings && <s-link href="/app/settings">{t("nav.settings")}</s-link>}
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
