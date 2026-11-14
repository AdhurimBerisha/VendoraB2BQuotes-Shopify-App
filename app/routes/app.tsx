import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { useMemo } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { createI18n, pickLocale } from "../lib/i18n";
import { getActor } from "../models/actor.server";
import { isDegraded } from "../models/health.server";
import { can } from "../models/permissions";
import { checkB2b, getShop, missingScopes, upsertShopOnInstall } from "../models/shop.server";

// Records the staff member on every admin page load. Child loaders that need the role call getActor too
// (the upsert is safe to run twice at once, see staff.server.test.ts).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);

  // Backfill for shops installed before afterAuth existed, or if afterAuth failed.
  const shop = await getShop(actor.shop);
  // !shop.name: shops installed before M3.3 get their name for email footers.
  if (!shop || shop.uninstalledAt || !shop.name) await upsertShopOnInstall(actor.admin, actor.shop);
  // M5.3: while the shop is flagged, ask again on each load so the banner goes once B2B is back.
  const b2bUnavailable = shop?.b2bUnavailable ? !(await checkB2b(actor.admin, actor.shop)) : false;

  return {
    // M5.3 store changes the merchant has to act on.
    storeChanged: { b2bUnavailable, scopesMissing: missingScopes(actor.session.scope).length > 0 },
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    // Admin language: ?locale= on the first load, else the staff member's saved locale.
    locale: pickLocale(new URL(request.url).searchParams.get("locale") ?? actor.locale),
    showJobs: can(actor, "jobs.retry"),
    // M4.2 degraded mode: nothing is blocked, jobs keep retrying; staff just know why it's slow.
    degraded: { shopify: isDegraded("shopify"), email: isDegraded("email") },
  };
};

export default function App() {
  const { apiKey, locale, showJobs, degraded, storeChanged } = useLoaderData<typeof loader>();
  const i18n = useMemo(() => createI18n(locale), [locale]);

  return (
    <AppProvider apiKey={apiKey}>
      <I18nextProvider i18n={i18n}>
        <Nav showJobs={showJobs} />
        <StoreChangedBanner storeChanged={storeChanged} />
        <DegradedBanner degraded={degraded} />
        <Outlet />
      </I18nextProvider>
    </AppProvider>
  );
}

function Nav({ showJobs }: { showJobs: boolean }) {
  const { t } = useTranslation();
  return (
    <s-app-nav>
      <s-link href="/app">{t("nav.dashboard")}</s-link>
      <s-link href="/app/quotes">{t("nav.quotes")}</s-link>
      {showJobs && <s-link href="/app/jobs">{t("nav.jobs")}</s-link>}
      <s-link href="/app/settings">{t("nav.settings")}</s-link>
    </s-app-nav>
  );
}

// M5.3 (App Store requirement 4.3): tell the merchant when the store changed under the app.
function StoreChangedBanner({ storeChanged }: { storeChanged: { b2bUnavailable: boolean; scopesMissing: boolean } }) {
  const { t } = useTranslation();
  if (!storeChanged.b2bUnavailable && !storeChanged.scopesMissing) return null;
  return (
    <s-banner tone="critical">
      {storeChanged.b2bUnavailable && <s-paragraph>{t("eligibility.b2bUnavailable")}</s-paragraph>}
      {storeChanged.scopesMissing && <s-paragraph>{t("eligibility.scopesMissing")}</s-paragraph>}
    </s-banner>
  );
}

function DegradedBanner({ degraded }: { degraded: { shopify: boolean; email: boolean } }) {
  const { t } = useTranslation();
  if (!degraded.shopify && !degraded.email) return null;
  return (
    <s-banner tone="warning">
      {degraded.shopify && <s-paragraph>{t("degraded.shopify")}</s-paragraph>}
      {degraded.email && <s-paragraph>{t("degraded.email")}</s-paragraph>}
    </s-banner>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
