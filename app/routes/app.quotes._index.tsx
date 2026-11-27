import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import ErrorBanner from "../components/ErrorBanner";
import StatusBadge from "../components/StatusBadge";
import { runAction } from "../lib/action.server";
import { formatDate } from "../lib/dates";
import { downloadFrom } from "../lib/download";
import { parseForm } from "../lib/validation";
import { D, formatMoney } from "../lib/money";
import { getActor } from "../models/actor.server";
import { parseRules } from "../models/approval";
import { type NextAction, nextAction } from "../models/next-action";
import { can, requirePermission } from "../models/permissions";
import { QUOTE_STATUSES } from "../models/quote";
import { listFiltersSchema, listQuotes, quoteLabel, searchFilters, viewFilters, viewQuery } from "../models/quote.server";
import { getShop, orB2bLost } from "../models/shop.server";
import { deleteView, getSavedViews, listStaff, saveView } from "../models/staff.server";
import { companyNames } from "../shopify/companies.server";

// M10.6: built-in views; their queries are viewQuery strings (fixed key order).
const BUILT_IN_VIEWS = [
  { id: "all", query: "" },
  { id: "mine", query: "assigned=me" },
  { id: "action", query: "action=me" },
  { id: "expiring", query: "expiring=7" },
  { id: "notViewed", query: "notViewed=1" },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "quote.view");
  const params = new URL(request.url).searchParams;
  const filters = listFiltersSchema.parse(Object.fromEntries(params));
  const [shop, staff, savedViews] = await Promise.all([getShop(actor.shop), listStaff(actor.shop), getSavedViews(actor)]);
  const prefix = shop?.quotePrefix ?? "Q-";
  const timezone = shop?.timezone ?? "UTC";

  // M5.3: a store that lost B2B can't read companies; the quotes still list, without names.
  const search = await orB2bLost(actor.shop, { companyIds: [] }, () => searchFilters(actor, filters.q, prefix));
  const { quotes, nextCursor } = await listQuotes(actor.shop, {
    ...search,
    status: filters.status,
    and: await viewFilters(actor, filters, shop),
    cursor: filters.cursor,
  });
  const names = await orB2bLost(actor.shop, new Map<string, string>(), () =>
    companyNames(actor.admin, actor.shop, [...new Set(quotes.map((quote) => quote.companyId))]),
  );
  const staffNames = new Map(staff.map((member) => [member.shopifyUserId, member.displayName]));
  const viewer = {
    userId: actor.userId,
    canApprove: can(actor, "quote.approve"),
    requireDifferentApprover: parseRules(shop?.approvalRules).requireDifferentApprover,
  };
  const now = new Date();

  return {
    quotes: quotes.map((quote) => ({
      id: quote.id,
      label: quoteLabel(prefix, quote.number),
      company: names.get(quote.companyId) ?? "",
      status: quote.status,
      total: formatMoney(quote.currentVersion?.total ?? D(0), quote.currencyCode, actor.locale),
      rep: quote.assignedToUserId === null ? "" : (staffNames.get(quote.assignedToUserId) ?? ""),
      updated: formatDate(quote.updatedAt, actor.locale, timezone),
      next: nextAction(
        {
          ...quote,
          pendingApproval: quote.currentVersion?.approvals[0] ?? null,
        },
        viewer,
        timezone,
        now,
      ),
    })),
    nextCursor,
    views: { builtIn: BUILT_IN_VIEWS, saved: savedViews, current: viewQuery(params) },
    canCreate: can(actor, "quote.create"),
    canExport: can(actor, "export.all"),
  };
};

const intentSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("saveView"), name: z.string().max(100), query: z.string().max(1000) }),
  z.object({ intent: z.literal("deleteView"), name: z.string().max(100) }),
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "quote.view");
  const form = await request.formData();
  return runAction(async () => {
    const input = parseForm(form, intentSchema);
    if (input.intent === "saveView") await saveView(actor, input.name, viewQuery(new URLSearchParams(input.query)));
    else await deleteView(actor, input.name);
    return { intent: input.intent };
  });
};

export default function QuoteList() {
  const { quotes, nextCursor, views, canCreate, canExport } = useLoaderData<typeof loader>();
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

  const filtered = views.current !== "";

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
      <ViewBar views={views} onOpen={(query) => navigate(query ? `?${query}` : "?")} />
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
            <s-table-header listSlot="inline">{t("quotes.columns.next")}</s-table-header>
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
                <s-table-cell>
                  <NextActionBadge next={quote.next} />
                </s-table-cell>
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

type Views = {
  builtIn: readonly { id: string; query: string }[];
  saved: { name: string; query: string }[];
  current: string;
};

// M10.6: one button per view (pressed = the list shows exactly its filters), then save/delete.
const ViewBar = ({ views, onOpen }: { views: Views; onOpen: (query: string) => void }) => {
  const { t } = useTranslation();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const savedCurrent = views.saved.find((view) => view.query === views.current);
  const matches = savedCurrent || views.builtIn.some((view) => view.query === views.current);

  return (
    <s-stack direction="block" gap="small-200">
      <ErrorBanner result={fetcher.data} />
      <s-stack direction="inline" gap="small-200" alignItems="center">
        {views.builtIn.map((view) => (
          <s-press-button key={view.id} pressed={view.query === views.current} onClick={() => onOpen(view.query)}>
            {t(`quotes.views.${view.id}`)}
          </s-press-button>
        ))}
        {views.saved.map((view) => (
          <s-press-button key={view.name} pressed={view.query === views.current} onClick={() => onOpen(view.query)}>
            {view.name}
          </s-press-button>
        ))}
        {!matches && (
          <s-button variant="tertiary" icon="plus" commandFor="save-view-modal" command="--show">
            {t("quotes.views.save")}
          </s-button>
        )}
        {savedCurrent && (
          <s-button
            variant="tertiary"
            tone="critical"
            onClick={() => fetcher.submit({ intent: "deleteView", name: savedCurrent.name }, { method: "post" })}
            {...(busy ? { loading: true } : {})}
          >
            {t("quotes.views.delete", { name: savedCurrent.name })}
          </s-button>
        )}
      </s-stack>
      <s-modal id="save-view-modal" heading={t("quotes.views.saveHeading")}>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="saveView" />
          <input type="hidden" name="query" value={views.current} />
          <s-stack direction="block" gap="base">
            <s-paragraph>{t("quotes.views.saveBody")}</s-paragraph>
            <s-text-field label={t("quotes.views.name")} name="name" maxLength={40} required></s-text-field>
            <s-button type="submit" variant="primary" commandFor="save-view-modal" command="--hide">
              {t("quotes.views.saveConfirm")}
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-modal>
    </s-stack>
  );
};

const NEXT_TONE: Record<NextAction["code"], "info" | "success" | "warning" | "critical" | "neutral"> = {
  attention: "critical",
  yourApproval: "warning",
  waitingApproval: "neutral",
  readyToSend: "info",
  expires: "warning",
  viewed: "success",
  notOpened: "neutral",
};

// M10.5: text, not colour only (a11y). Days are shop-local (M10.1).
const NextActionBadge = ({ next }: { next: NextAction | null }) => {
  const { t } = useTranslation();
  if (!next) return null;
  const count = "days" in next ? next.days : undefined;
  return <s-badge tone={NEXT_TONE[next.code]}>{t(`quotes.next.${next.code}`, { count })}</s-badge>;
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
