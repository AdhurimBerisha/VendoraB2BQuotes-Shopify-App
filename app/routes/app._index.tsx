import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useEffect } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import { runAction, type ActionResult } from "../lib/action.server";
import { UserError } from "../lib/errors";
import { D, formatMoney } from "../lib/money";
import { gid, parseForm, quantity } from "../lib/validation";
import { getActor } from "../models/actor.server";
import { createQuote, listQuotes, quoteLabel } from "../models/quote.server";
import { getShop } from "../models/shop.server";
import { requestSync } from "../models/sync.server";
import { saveDraftLines } from "../models/version.server";
import { searchCompanies } from "../shopify/companies.server";
import { getVariant } from "../shopify/products.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const shopResponse = await admin.graphql(
    `#graphql
    query VendoraQuoteShopAndVariants {
      shop { plan { shopifyPlus partnerDevelopment } }
      productVariants(first: 50) {
        nodes { id title product { title } }
      }
    }`,
  );
  const { data: shopData } = await shopResponse.json();

  let companies: Awaited<ReturnType<typeof searchCompanies>>["nodes"] = [];
  let b2bError: string | null = null;
  try {
    companies = (await searchCompanies(admin)).nodes;
  } catch (error) {
    if (error instanceof Response) throw error; // let re-auth redirects through
    b2bError = error instanceof Error ? error.message : String(error);
  }

  const prefix = (await getShop(session.shop))?.quotePrefix ?? "Q-";
  const { quotes } = await listQuotes(session.shop);

  return {
    plan: shopData?.shop.plan ?? null,
    variants: shopData?.productVariants.nodes ?? [],
    companies,
    b2bError,
    quotes: quotes.map((quote) => ({
      id: quote.id,
      label: quoteLabel(prefix, quote.number),
      status: quote.status,
      syncStatus: quote.syncStatus,
      syncError: quote.syncError,
      draftOrderId: quote.draftOrderId,
      total: formatMoney(quote.currentVersion?.total ?? D(0), quote.currencyCode),
    })),
  };
};

const createSchema = z.object({
  intent: z.literal("create"),
  locationId: gid("CompanyLocation"),
  variantId: gid("ProductVariant"),
  quantity,
});
const syncSchema = z.object({ intent: z.literal("sync"), quoteId: z.string().min(1) });

export const action = async ({ request }: ActionFunctionArgs) => {
  const actor = await getActor(request);
  const { admin } = actor;
  const form = await request.formData();

  return runAction(async () => {
    if (form.get("intent") === "sync") {
      await requestSync(actor, parseForm(form, syncSchema).quoteId);
      return null;
    }
    const input = parseForm(form, createSchema);
    const variant = await getVariant(admin, input.variantId);
    if (!variant) throw new UserError("quote.errors.variantNotFound");
    const quote = await createQuote(actor, { locationId: input.locationId });
    // A new quote's lockVersion is 0. The line editor itself arrives with the admin UI (M2.8).
    await saveDraftLines(
      actor,
      quote.id,
      0,
      [
        {
          variantId: variant.id,
          productId: variant.product.id,
          sku: variant.sku ?? null,
          title: variant.product.title,
          quantity: input.quantity,
          catalogPrice: D(variant.price),
        },
      ],
      null,
    );
    return null;
  });
};

// ponytail: shows raw translation keys until app/locales arrives in M2.8.
const errorText = (result: ActionResult<unknown> | undefined) => {
  if (!result || result.ok) return null;
  const params = Object.entries(result.error.params).map(([k, v]) => `${k}: ${v}`);
  return [result.error.key, ...params].join(" · ");
};

export default function Index() {
  const { plan, variants, companies, b2bError, quotes } =
    useLoaderData<typeof loader>();
  const createFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const createError = errorText(createFetcher.data);

  // Refresh every 3 s while a background sync is running.
  const inFlight = quotes.some(
    (quote) => quote.syncStatus === "QUEUED" || quote.syncStatus === "SYNCING",
  );
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [inFlight, revalidator]);

  return (
    <s-page heading="Quotes">
      <s-section heading="Store eligibility">
        <s-stack direction="inline" gap="base">
          <s-badge tone={plan?.shopifyPlus ? "success" : "warning"}>
            Plus: {plan?.shopifyPlus ? "yes" : "no"}
          </s-badge>
          <s-badge>
            Dev store: {plan?.partnerDevelopment ? "yes" : "no"}
          </s-badge>
        </s-stack>
        {b2bError && (
          <s-banner tone="critical" heading="B2B isn't available on this store">
            Needs a Plus plan or a Plus dev store, plus protected customer data
            access. Shopify said: {b2bError}
          </s-banner>
        )}
      </s-section>

      <s-section heading="New quote">
        <createFetcher.Form method="post">
          <input type="hidden" name="intent" value="create" />
          <s-stack direction="block" gap="base">
            <s-select label="Company location" name="locationId">
              {companies.flatMap((company) =>
                company.locations.nodes.map((location) => (
                  <s-option key={location.id} value={location.id}>
                    {company.name} — {location.name} ({location.currency})
                    {company.mainContact ? "" : " (no main contact)"}
                  </s-option>
                )),
              )}
            </s-select>
            <s-select label="Variant" name="variantId">
              {variants.map((variant) => (
                <s-option key={variant.id} value={variant.id}>
                  {variant.product.title} — {variant.title}
                </s-option>
              ))}
            </s-select>
            <s-number-field
              label="Quantity"
              name="quantity"
              value="1"
              min={1}
              max={100000}
              step={1}
            ></s-number-field>
            <s-button
              type="submit"
              variant="primary"
              {...(createFetcher.state !== "idle" ? { loading: true } : {})}
            >
              Create quote
            </s-button>
            {createError && <s-banner tone="critical">{createError}</s-banner>}
          </s-stack>
        </createFetcher.Form>
      </s-section>

      <s-section heading="Quotes">
        {quotes.length === 0 ? (
          <s-paragraph>No quotes yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {quotes.map((quote) => (
              <QuoteRow key={quote.id} quote={quote} />
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

const SYNC_LABELS: Record<string, string> = {
  QUEUED: "Waiting to sync",
  SYNCING: "Syncing…",
  SYNCED: "Draft order created",
  FAILED: "Sync failed",
};

function QuoteRow({
  quote,
}: {
  quote: {
    id: string;
    label: string;
    status: string;
    syncStatus: string;
    syncError: string | null;
    draftOrderId: string | null;
    total: string;
  };
}) {
  const fetcher = useFetcher<typeof action>();
  const error = errorText(fetcher.data) ?? quote.syncError;
  const canSync = quote.syncStatus === "NONE" || quote.syncStatus === "FAILED";

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text type="strong">{quote.label}</s-text>
          <s-badge>{quote.status}</s-badge>
          <s-text>{quote.total}</s-text>
          {quote.syncStatus !== "NONE" && (
            <s-badge tone={quote.syncStatus === "SYNCED" ? "success" : "auto"}>
              {SYNC_LABELS[quote.syncStatus] ?? quote.syncStatus}
            </s-badge>
          )}
          {quote.draftOrderId && (
            <s-link
              href={`shopify://admin/draft_orders/${quote.draftOrderId.split("/").pop()}`}
              target="_top"
            >
              Open draft order
            </s-link>
          )}
          {!quote.draftOrderId && canSync && (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="sync" />
              <input type="hidden" name="quoteId" value={quote.id} />
              <s-button
                type="submit"
                {...(fetcher.state !== "idle" ? { loading: true } : {})}
              >
                Convert to draft order
              </s-button>
            </fetcher.Form>
          )}
        </s-stack>
        {error && <s-text tone="critical">{error}</s-text>}
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
