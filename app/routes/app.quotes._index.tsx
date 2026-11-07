import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import StatusBadge from "../components/StatusBadge";
import { formatDate } from "../lib/dates";
import { downloadFrom } from "../lib/download";
import { D, formatMoney } from "../lib/money";
import { getActor } from "../models/actor.server";
import { can, requirePermission } from "../models/permissions";
import { QUOTE_STATUSES, listFiltersSchema, listQuotes, quoteLabel, searchFilters } from "../models/quote.server";
import { getShop } from "../models/shop.server";
import { listStaff } from "../models/staff.server";
import { companyNames } from "../shopify/companies.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "quote.view");
  const filters = listFiltersSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const [shop, staff] = await Promise.all([getShop(actor.shop), listStaff(actor.shop)]);
  const prefix = shop?.quotePrefix ?? "Q-";
  const timezone = shop?.timezone ?? "UTC";

  const search = await searchFilters(actor, filters.q, prefix);
  const { quotes, nextCursor } = await listQuotes(actor.shop, {
    ...search,
    status: filters.status,
    cursor: filters.cursor,
  });
  const names = await companyNames(actor.admin, actor.shop, [...new Set(quotes.map((quote) => quote.companyId))]);
  const staffNames = new Map(staff.map((member) => [member.shopifyUserId, member.displayName]));

  return {
    quotes: quotes.map((quote) => ({
      id: quote.id,
      label: quoteLabel(prefix, quote.number),
      company: names.get(quote.companyId) ?? "",
      status: quote.status,
      total: formatMoney(quote.currentVersion?.total ?? D(0), quote.currencyCode, actor.locale),
      rep: quote.assignedToUserId === null ? "" : (staffNames.get(quote.assignedToUserId) ?? ""),
      updated: formatDate(quote.updatedAt, actor.locale, timezone),
    })),
    nextCursor,
    canCreate: can(actor, "quote.create"),
    canExport: can(actor, "export.all"),
  };
};

export default function QuoteList() {
  const { quotes, nextCursor, canCreate, canExport } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  // Previous pages' cursors travel in the URL ("prev", page 1 = "first"), so Back works after a reload.
  const previous = (params.get("prev") ?? "").split(",").filter(Boolean);
  const go = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    navigate(`?${next.toString()}`);
  };
  // A new search or filter starts at page 1.
  const filterBy = (key: "q" | "status", value: string) => go({ [key]: value || null, cursor: null, prev: null });
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const nextPage = () =>
    nextCursor && go({ cursor: nextCursor, prev: [...previous, params.get("cursor") ?? "first"].join(",") });
  const previousPage = () => {
    const stack = [...previous];
    const cursor = stack.pop();
    go({ cursor: cursor === "first" ? null : (cursor ?? null), prev: stack.length ? stack.join(",") : null });
  };

  const exportCsv = async () => {
    setExporting(true);
    setExportFailed(false);
    const search = new URLSearchParams(params);
    search.delete("cursor");
    search.delete("prev");
    try {
      await downloadFrom(`/app/quotes/export?${search.toString()}`, "vendora-quotes.csv");
    } catch (error) {
      console.error("quote export failed", error);
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  };

  const filtered = Boolean(params.get("q") || params.get("status"));

  return (
    <s-page heading={t("quotes.title")}>
      {canCreate && (
        <s-button slot="primary-action" variant="primary" href="/app/quotes/new">
          {t("quotes.new")}
        </s-button>
      )}
      {canExport && (
        <s-button slot="secondary-actions" onClick={exportCsv} {...(exporting ? { loading: true } : {})}>
          {t("quotes.export")}
        </s-button>
      )}
      {exportFailed && <s-banner tone="critical">{t("quotes.exportFailed")}</s-banner>}
      <s-section padding="none">
        <s-table
          paginate
          hasNextPage={!!nextCursor}
          hasPreviousPage={!!params.get("cursor")}
          onNextPage={nextPage}
          onPreviousPage={previousPage}
        >
          <s-grid slot="filters" gridTemplateColumns="2fr 1fr" gap="small-200">
            <s-search-field
              label={t("quotes.search")}
              labelAccessibilityVisibility="exclusive"
              placeholder={t("quotes.searchPlaceholder")}
              value={params.get("q") ?? ""}
              onInput={(event) => {
                const value = event.currentTarget.value;
                clearTimeout(searchTimer.current);
                searchTimer.current = setTimeout(() => filterBy("q", value), 300);
              }}
            ></s-search-field>
            <s-select
              label={t("quotes.statusFilter")}
              labelAccessibilityVisibility="exclusive"
              value={params.get("status") ?? ""}
              onChange={(event) => filterBy("status", event.currentTarget.value)}
            >
              <s-option value="">{t("quotes.allStatuses")}</s-option>
              {QUOTE_STATUSES.map((status) => (
                <s-option key={status} value={status}>
                  {t(`quote.status.${status}`)}
                </s-option>
              ))}
            </s-select>
          </s-grid>
          <s-table-header-row>
            <s-table-header listSlot="primary">{t("quotes.columns.number")}</s-table-header>
            <s-table-header listSlot="secondary">{t("quotes.columns.company")}</s-table-header>
            <s-table-header listSlot="inline">{t("quotes.columns.status")}</s-table-header>
            <s-table-header listSlot="labeled" format="currency">
              {t("quotes.columns.total")}
            </s-table-header>
            <s-table-header listSlot="labeled">{t("quotes.columns.rep")}</s-table-header>
            <s-table-header listSlot="labeled">{t("quotes.columns.updated")}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {quotes.map((quote) => (
              <s-table-row key={quote.id} clickDelegate={`quote-link-${quote.id}`}>
                <s-table-cell>
                  <s-link id={`quote-link-${quote.id}`} href={`/app/quotes/${quote.id}`}>
                    {quote.label}
                  </s-link>
                </s-table-cell>
                <s-table-cell>{quote.company}</s-table-cell>
                <s-table-cell>
                  <StatusBadge status={quote.status} />
                </s-table-cell>
                <s-table-cell>{quote.total}</s-table-cell>
                <s-table-cell>{quote.rep}</s-table-cell>
                <s-table-cell>{quote.updated}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {quotes.length === 0 && (
          <s-box padding="base">
            <s-paragraph>{filtered ? t("quotes.noMatches") : t("quotes.empty")}</s-paragraph>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
