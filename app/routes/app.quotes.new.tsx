import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect, useRef } from "react";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import ErrorBanner from "../components/ErrorBanner";
import { runAction } from "../lib/action.server";
import { UserError } from "../lib/errors";
import { gid, parseForm } from "../lib/validation";
import { getActor } from "../models/actor.server";
import { requirePermission } from "../models/permissions";
import { createQuote } from "../models/quote.server";
import { orB2bLost } from "../models/shop.server";
import { searchCompanies } from "../shopify/companies.server";

// Choose a company location (B-3: nothing pre-selected; B-4: search instead of a capped list).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "quote.create");
  const q = new URL(request.url).searchParams.get("q")?.trim().slice(0, 100) ?? "";
  // M5.3: a store that lost B2B has no companies to choose from (the banner in app.tsx says why).
  const companies = await orB2bLost(actor.shop, { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, () =>
    searchCompanies(actor.admin, q || undefined),
  );
  return {
    companies: companies.nodes.map((company) => ({
      id: company.id,
      name: company.name,
      hasContact: !!company.mainContact,
      locations: company.locations.nodes.map((location) => ({
        id: location.id,
        name: location.name,
        currency: location.currency,
      })),
    })),
    hasMore: companies.pageInfo.hasNextPage,
  };
};

const createSchema = z.object({ locationId: gid("CompanyLocation") });

export const action = async ({ request }: ActionFunctionArgs) => {
  const actor = await getActor(request);
  const form = await request.formData();
  return runAction(async () => {
    // The one field a user can leave empty here: say so in words, not "locationId".
    if (!form.get("locationId")) throw new UserError("newQuote.locationRequired");
    const quote = await createQuote(actor, parseForm(form, createSchema));
    return { quoteId: quote.id };
  });
};

export default function NewQuote() {
  const { companies, hasMore } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) navigate(`/app/quotes/${fetcher.data.data.quoteId}`);
  }, [fetcher.state, fetcher.data, navigate]);

  return (
    <s-page heading={t("newQuote.title")}>
      <s-link slot="breadcrumb-actions" href="/app/quotes">
        {t("nav.quotes")}
      </s-link>
      <ErrorBanner result={fetcher.data} />
      <s-section heading={t("newQuote.chooseLocation")}>
        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            <s-search-field
              label={t("newQuote.searchCompanies")}
              placeholder={t("newQuote.searchPlaceholder")}
              value={params.get("q") ?? ""}
              onInput={(event) => {
                const value = event.currentTarget.value;
                clearTimeout(searchTimer.current);
                searchTimer.current = setTimeout(() => navigate(value ? `?q=${encodeURIComponent(value)}` : "?"), 300);
              }}
            ></s-search-field>
            {companies.length === 0 ? (
              <s-paragraph>{t("newQuote.noCompanies")}</s-paragraph>
            ) : (
              <s-choice-list label={t("newQuote.location")} name="locationId">
                {companies.flatMap((company) =>
                  company.locations.map((location) => (
                    <s-choice key={location.id} value={location.id} disabled={!company.hasContact}>
                      {company.name} · {location.name}
                      <s-text slot="details">{company.hasContact ? location.currency : t("newQuote.noMainContact")}</s-text>
                    </s-choice>
                  )),
                )}
              </s-choice-list>
            )}
            {hasMore && <s-text color="subdued">{t("newQuote.refineSearch")}</s-text>}
            <s-button type="submit" variant="primary" {...(fetcher.state !== "idle" ? { loading: true } : {})}>
              {t("newQuote.create")}
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
