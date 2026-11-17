import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useCallback, useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import ErrorBanner from "../components/ErrorBanner";
import StatusBadge from "../components/StatusBadge";
import usePollWhile from "../components/usePollWhile";
import db from "../db.server";
import { runAction } from "../lib/action.server";
import { formatDateTime, localDateString } from "../lib/dates";
import { downloadFrom } from "../lib/download";
import { D, type Money, formatMoney } from "../lib/money";
import { gid, parseForm } from "../lib/validation";
import { getActor } from "../models/actor.server";
import { decide, submitQuote } from "../models/approval.server";
import { ATTENTION_ACTIONS, type AttentionAction, type AttentionCode, attentionItems } from "../models/attention";
import { resolveAttention } from "../models/attention-actions.server";
import { quoteHistory } from "../models/audit.server";
import { can, requirePermission } from "../models/permissions";
import { BLOCKING, type LineProblem } from "../models/pricing";
import { cancelQuote, getQuote, quoteLabel, setExpiry } from "../models/quote.server";
import { getShop } from "../models/shop.server";
import { listStaff } from "../models/staff.server";
import { requestSync, sendQuote } from "../models/sync.server";
import { logger } from "../lib/logger.server";
import { diffVersions, reviseQuote, saveDraftLines } from "../models/version.server";
import { getCompanyLocation, getContact } from "../shopify/companies.server";
import { getDraftOrderSummary } from "../shopify/draft-orders.server";

// Shopify data shown on the page; if Shopify fails, the quote still shows.
const orNull = async <T,>(what: string, fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.warn({ what, message: error instanceof Error ? error.message : String(error) }, "quote page: Shopify data unavailable");
    return null;
  }
};

const problemsOf = (json: unknown): LineProblem[] => (Array.isArray(json) ? (json as LineProblem[]) : []);
const percentText = (value: Money | null) => (value === null ? "" : value.toString());

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "quote.view");
  const [quote, shop] = await Promise.all([getQuote(actor.shop, params.id ?? ""), getShop(actor.shop)]);
  const version = quote.currentVersion;
  const prefix = shop?.quotePrefix ?? "Q-";
  const timezone = shop?.timezone ?? "UTC";
  const money = (value: Money) => formatMoney(value, quote.currencyCode, actor.locale);
  const when = (date: Date) => formatDateTime(date, actor.locale, timezone);

  const [versions, events, staff, pendingApproval, location, contact, draft] = await Promise.all([
    db.quoteVersion.findMany({
      where: { quoteId: quote.id },
      include: { lines: { orderBy: { position: "asc" } } },
      orderBy: { versionNumber: "asc" },
    }),
    quoteHistory(actor.shop, quote.id),
    listStaff(actor.shop),
    version
      ? db.approval.findFirst({ where: { versionId: version.id, decision: null }, orderBy: { createdAt: "desc" } })
      : Promise.resolve(null),
    orNull("location", () => getCompanyLocation(actor.admin, quote.companyLocationId)),
    orNull("contact", () => getContact(actor.admin, quote.companyContactId)), // shown, never stored (D-10)
    quote.draftOrderId ? orNull("draft order", () => getDraftOrderSummary(actor.admin, quote.draftOrderId!)) : null,
  ]);
  const staffName = (userId: bigint | string | null) =>
    userId === null ? null : (staff.find((member) => member.shopifyUserId.toString() === userId.toString())?.displayName ?? null);
  const address = location?.shippingAddress;
  const isOwn = actor.userId !== null && quote.assignedToUserId === actor.userId;

  return {
    quote: {
      id: quote.id,
      label: quoteLabel(prefix, quote.number),
      status: quote.status,
      syncStatus: quote.syncStatus,
      syncError: quote.syncError,
      lockVersion: quote.lockVersion,
      currency: quote.currencyCode,
      rep: staffName(quote.assignedToUserId),
      expires: quote.expiresAt ? when(quote.expiresAt) : null,
      expiresOn: quote.expiresAt ? localDateString(quote.expiresAt, timezone) : "",
      today: localDateString(new Date(), timezone),
      draftOrderNumericId: quote.draftOrderId?.split("/").pop() ?? null,
      orderNumericId: quote.orderId?.split("/").pop() ?? null,
      attention: attentionItems(quote.attention).map((item) => ({ code: item.code, message: item.message ?? "" })),
    },
    version: version && {
      number: version.versionNumber,
      locked: !!version.lockedAt,
      quoteDiscountPct: percentText(version.quoteDiscountPct),
      listTotal: money(version.listTotal),
      discountTotal: money(version.discountTotal),
      total: money(version.total),
      lines: version.lines.map((line) => ({
        variantId: line.variantId,
        title: line.titleSnapshot,
        sku: line.sku ?? "",
        quantity: line.quantity,
        catalogPrice: money(line.catalogPrice),
        overridePrice: percentText(line.overridePrice),
        discountPct: percentText(line.discountPct),
        lineTotal: money(line.lineTotal),
        problems: problemsOf(line.problems),
      })),
    },
    customer: {
      company: location?.company.name ?? null,
      location: location?.name ?? null,
      contactName: contact?.customer?.displayName ?? null,
      contactEmail: contact?.customer?.defaultEmailAddress?.emailAddress ?? null,
      buyerMessage: version?.internalNote ?? null, // set by the storefront quote button (M3.5)
      address: address
        ? [address.recipient, address.address1, address.address2, [address.zip, address.city].filter(Boolean).join(" "), address.countryCode]
            .filter(Boolean)
            .join(", ")
        : null,
    },
    approval: pendingApproval && {
      reasons: (pendingApproval.reasons as { code: string; detail?: string }[]).map((reason) => ({
        code: reason.code,
        detail: reason.detail ?? "",
      })),
      requestedBy: staffName(pendingApproval.requestedBy),
    },
    shopify: draft && {
      status: draft.status,
      invoiceSentAt: draft.invoiceSentAt ? when(new Date(draft.invoiceSentAt)) : null,
      subtotal: money(D(draft.subtotalPriceSet.presentmentMoney.amount)),
      tax: money(D(draft.totalTaxSet.presentmentMoney.amount)),
      total: money(D(draft.totalPriceSet.presentmentMoney.amount)),
      orderName: draft.order?.name ?? null,
    },
    versions: versions.map((item, index) => ({
      number: item.versionNumber,
      created: when(item.createdAt),
      author: staffName(item.createdByUserId),
      total: money(item.total),
      locked: !!item.lockedAt,
      changes: index === 0 ? [] : diffVersions(versions[index - 1], item),
    })),
    history: events.map((event) => ({
      id: event.id,
      at: when(event.createdAt),
      action: event.action,
      actorType: event.actorType,
      actor: event.actorType === "STAFF" ? staffName(event.actorId) : null,
    })),
    perms: {
      edit: can(actor, "quote.edit"),
      submit: can(actor, "quote.submit"),
      approve: can(actor, "quote.approve"),
      send: can(actor, "quote.send"),
      cancel: can(actor, "quote.cancel.any") || (isOwn && can(actor, "quote.cancel.own")),
      import: can(actor, "import.run"),
      retry: can(actor, "attention.resolve"),
      setExpiry: can(actor, "quote.edit") && ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT"].includes(quote.status),
    },
  };
};

// "" → null; otherwise a non-negative decimal.
const optionalDecimal = (max?: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(",", "."))
    .refine((value) => value === "" || (/^\d{1,10}(\.\d{1,4})?$/.test(value) && (max === undefined || Number(value) <= max)))
    .transform((value) => (value === "" ? null : D(value)));

const lineSchema = z.object({
  variantId: gid("ProductVariant"),
  quantity: z.coerce.number().int().min(1).max(100_000),
  overridePrice: optionalDecimal(),
  discountPct: optionalDecimal(100),
});

const intentSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("saveLines"),
    lockVersion: z.coerce.number().int(),
    lines: z.string().transform((text, ctx) => {
      try {
        return z.array(lineSchema).max(500).parse(JSON.parse(text));
      } catch {
        ctx.addIssue({ code: "custom", message: "invalid lines" });
        return z.NEVER;
      }
    }),
    quoteDiscountPct: optionalDecimal(100),
  }),
  z.object({ intent: z.literal("submit") }),
  z.object({ intent: z.literal("approve"), comment: z.string().max(2000).optional() }),
  z.object({ intent: z.literal("reject"), comment: z.string().max(2000).optional() }),
  z.object({ intent: z.literal("revise") }),
  z.object({ intent: z.literal("send"), message: z.string().max(5000).default("") }),
  z.object({ intent: z.literal("retrySync") }),
  z.object({
    intent: z.literal("resolve"),
    code: z.enum(Object.keys(ATTENTION_ACTIONS) as [AttentionCode, ...AttentionCode[]]),
    action: z.string().max(40),
  }),
  z.object({ intent: z.literal("cancel"), reason: z.string().max(500).optional() }),
  z.object({ intent: z.literal("setExpiry"), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const actor = await getActor(request);
  const form = await request.formData();
  const id = params.id ?? "";
  return runAction(async () => {
    const input = parseForm(form, intentSchema);
    switch (input.intent) {
      case "saveLines":
        await saveDraftLines(actor, id, input.lockVersion, input.lines, input.quoteDiscountPct);
        break;
      case "submit":
        await submitQuote(actor, id);
        break;
      case "approve":
        await decide(actor, id, "APPROVED", input.comment);
        break;
      case "reject":
        await decide(actor, id, "REJECTED", input.comment);
        break;
      case "revise":
        await reviseQuote(actor, id);
        break;
      case "send":
        await sendQuote(actor, id, input.message);
        break;
      case "retrySync":
        requirePermission(actor, "attention.resolve");
        await requestSync(actor, id);
        break;
      case "resolve":
        // resolveAttention checks that the action belongs to the code.
        await resolveAttention(actor, id, input.code, input.action as AttentionAction);
        break;
      case "cancel":
        await cancelQuote(actor, id, input.reason);
        break;
      case "setExpiry":
        await setExpiry(actor, id, input.expiresOn);
        break;
    }
    return { intent: input.intent };
  });
};

type LoaderData = ReturnType<typeof useLoaderData<typeof loader>>;

export default function QuoteDetail() {
  const data = useLoaderData<typeof loader>();
  const { quote, version, perms } = data;
  const { t } = useTranslation();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle" ? { loading: true } : {};
  const submit = (intent: string, fields: Record<string, string> = {}) =>
    fetcher.submit({ intent, ...fields }, { method: "post" });
  const syncing = quote.syncStatus === "QUEUED" || quote.syncStatus === "SYNCING";
  // After a successful Send, the invoice job runs after the sync: keep polling until SENT or a problem shows.
  const sendAccepted = fetcher.state === "idle" && fetcher.data?.ok === true && fetcher.data.data.intent === "send";
  const sending =
    sendAccepted && quote.status === "APPROVED" && quote.attention.length === 0 && !["FAILED", "NEEDS_ATTENTION"].includes(quote.syncStatus);
  usePollWhile(syncing || sending);

  const [pdfState, setPdfState] = useState<"idle" | "loading" | "failed">("idle");
  const downloadPdf = useCallback(
    async (versionNumber?: number) => {
      setPdfState("loading");
      try {
        const query = versionNumber ? `?v=${versionNumber}` : "";
        const number = versionNumber ?? version?.number ?? 1;
        await downloadFrom(`/app/quotes/${quote.id}/pdf${query}`, `${quote.label}-v${number}.pdf`);
        setPdfState("idle");
      } catch (error) {
        console.error("quote pdf download failed", error);
        setPdfState("failed");
      }
    },
    [quote.id, quote.label, version?.number],
  );

  const editable = !!version && !version.locked && perms.edit;
  const canRevise = perms.edit && ["APPROVED", "SENT", "DECLINED", "EXPIRED"].includes(quote.status);
  const canCancel = perms.cancel && !["ORDERED", "CANCELLED"].includes(quote.status);

  return (
    <s-page heading={version ? t("quote.heading", { label: quote.label, version: version.number }) : quote.label}>
      <s-link slot="breadcrumb-actions" href="/app/quotes">
        {t("nav.quotes")}
      </s-link>
      {quote.status === "DRAFT" && perms.submit && (
        <s-button slot="primary-action" variant="primary" onClick={() => submit("submit")} {...busy}>
          {t("quote.actions.submit")}
        </s-button>
      )}
      {canRevise && (
        <s-button slot="secondary-actions" onClick={() => submit("revise")} {...busy}>
          {t("quote.actions.revise")}
        </s-button>
      )}
      {editable && perms.import && (
        <s-button slot="secondary-actions" href={`/app/quotes/${quote.id}/import`}>
          {t("quote.actions.import")}
        </s-button>
      )}
      {version && (
        <s-button slot="secondary-actions" onClick={() => downloadPdf()} {...(pdfState === "loading" ? { loading: true } : {})}>
          {t("quote.actions.pdf")}
        </s-button>
      )}
      {canCancel && (
        <s-button slot="secondary-actions" tone="critical" commandFor="cancel-modal" command="--show">
          {t("quote.actions.cancel")}
        </s-button>
      )}

      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <StatusBadge status={quote.status} />
          {quote.rep && <s-text color="subdued">{t("quote.rep", { name: quote.rep })}</s-text>}
          {quote.expires && <s-text color="subdued">{t("quote.expires", { date: quote.expires })}</s-text>}
        </s-stack>
        <ErrorBanner result={fetcher.data} />
        {pdfState === "failed" && <s-banner tone="critical">{t("quote.pdfFailed")}</s-banner>}
        <ProblemsBanner data={data} onResolve={(code, action) => submit("resolve", { code, action })} busy={fetcher.state !== "idle"} />
        {perms.setExpiry && <ExpiryForm expiresOn={quote.expiresOn} today={quote.today} />}
      </s-stack>

      <CustomerSection customer={data.customer} />
      {version && (
        <LinesSection
          key={version.number}
          quoteId={quote.id}
          lockVersion={quote.lockVersion}
          version={version}
          editable={editable}
          currency={quote.currency}
        />
      )}
      {quote.status === "PENDING_APPROVAL" && perms.approve && data.approval && (
        <ApprovalSection approval={data.approval} onDecide={submit} busy={fetcher.state !== "idle"} />
      )}
      {quote.status === "APPROVED" && perms.send && (
        <SendSection onSend={(message) => submit("send", { message })} busy={fetcher.state !== "idle" || sending} syncing={syncing} />
      )}
      <ShopifySection data={data} onRetry={() => submit("retrySync")} busy={fetcher.state !== "idle"} />
      <VersionsSection versions={data.versions} onPdf={downloadPdf} />
      <HistorySection history={data.history} />

      <s-modal id="cancel-modal" heading={t("quote.cancelModal.heading")}>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="cancel" />
          <s-stack direction="block" gap="base">
            <s-paragraph>{t("quote.cancelModal.body")}</s-paragraph>
            <s-text-field label={t("quote.cancelModal.reason")} name="reason" maxLength={500}></s-text-field>
            <s-button type="submit" tone="critical" variant="primary" commandFor="cancel-modal" command="--hide">
              {t("quote.cancelModal.confirm")}
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-modal>
    </s-page>
  );
}

// The quote expires at the end of this day in the shop's time zone.
function ExpiryForm({ expiresOn, today }: { expiresOn: string; today: string }) {
  const { t } = useTranslation();
  const fetcher = useFetcher<typeof action>();
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="setExpiry" />
      <s-grid gridTemplateColumns="1fr auto" gap="small-200" alignItems="end">
        <s-date-field
          label={t("quote.expiry.label")}
          details={t("quote.expiry.help")}
          name="expiresOn"
          value={expiresOn}
          allow={`${today}--`}
          required
        ></s-date-field>
        <s-button type="submit" {...(fetcher.state !== "idle" ? { loading: true } : {})}>
          {t("quote.expiry.save")}
        </s-button>
      </s-grid>
      <ErrorBanner result={fetcher.data} />
    </fetcher.Form>
  );
}

// B-18: one place for everything wrong with the quote (line problems, attention items, sync error).
// M4.2: each attention item has its own action buttons (ATTENTION_ACTIONS).
function ProblemsBanner({
  data,
  onResolve,
  busy,
}: {
  data: LoaderData;
  onResolve: (code: AttentionCode, action: AttentionAction) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const blocking = (data.version?.lines ?? []).filter((line) => line.problems.some((problem) => BLOCKING.includes(problem)));
  const hasSyncItem = data.quote.attention.some((item) => item.code === "SYNC_FAILED" || item.code === "RETRIES_EXHAUSTED");
  const other = [
    ...(data.quote.syncError && !hasSyncItem ? [t("attention.SYNC_FAILED", { message: data.quote.syncError })] : []),
    ...(blocking.length ? [t("quote.problems.blockingLines", { count: blocking.length })] : []),
  ];
  if (data.quote.attention.length === 0 && other.length === 0) return null;
  return (
    <s-banner tone="warning" heading={t("quote.problems.heading")}>
      <s-unordered-list>
        {data.quote.attention.map((item) => (
          <s-list-item key={item.code}>
            <s-stack direction="block" gap="small-200">
              <s-text>{t(`attention.${item.code}`, { message: item.message })}</s-text>
              {data.perms.retry && (
                <s-stack direction="inline" gap="small-200">
                  {(ATTENTION_ACTIONS[item.code] as readonly AttentionAction[]).map((action, index) => (
                    <s-button
                      key={action}
                      variant={index === 0 ? "primary" : "secondary"}
                      tone={action === "cancel" ? "critical" : "auto"}
                      onClick={() => onResolve(item.code, action)}
                      {...(busy ? { loading: true } : {})}
                    >
                      {t(`attention.actions.${action}`)}
                    </s-button>
                  ))}
                </s-stack>
              )}
            </s-stack>
          </s-list-item>
        ))}
        {other.map((message) => (
          <s-list-item key={message}>{message}</s-list-item>
        ))}
      </s-unordered-list>
    </s-banner>
  );
}

function CustomerSection({ customer }: { customer: LoaderData["customer"] }) {
  const { t } = useTranslation();
  const unknown = t("quote.customer.unavailable");
  return (
    <s-section heading={t("quote.customer.title")}>
      <s-grid gridTemplateColumns="1fr 1fr" gap="base">
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">{customer.company ?? unknown}</s-text>
          <s-text>{customer.location ?? ""}</s-text>
          <s-text color="subdued">{customer.address ?? t("quote.customer.noAddress")}</s-text>
        </s-stack>
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">{customer.contactName ?? unknown}</s-text>
          <s-text>{customer.contactEmail ?? t("quote.customer.noEmail")}</s-text>
        </s-stack>
      </s-grid>
      {customer.buyerMessage && (
        <s-box paddingBlockStart="base">
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">{t("quote.customer.buyerMessage")}</s-text>
            <s-paragraph>{customer.buyerMessage}</s-paragraph>
          </s-stack>
        </s-box>
      )}
    </s-section>
  );
}

type EditLine = {
  variantId: string;
  title: string;
  sku: string;
  quantity: string;
  overridePrice: string;
  discountPct: string;
  catalogPrice: string; // formatted; "" for lines not saved yet
  lineTotal: string;
  problems: LineProblem[];
};

const quantityError = (value: string) => !/^\d+$/.test(value) || +value < 1 || +value > 100_000;
const decimalError = (value: string, max?: number) => {
  const normalised = value.trim().replace(",", ".");
  if (normalised === "") return false;
  return !/^\d{1,10}(\.\d{1,4})?$/.test(normalised) || (max !== undefined && Number(normalised) > max);
};

// Lines of the current version. Totals come from the server after Save (prices and breaks are Shopify's).
function LinesSection({
  quoteId,
  lockVersion,
  version,
  editable,
  currency,
}: {
  quoteId: string;
  lockVersion: number;
  version: NonNullable<LoaderData["version"]>;
  editable: boolean;
  currency: string;
}) {
  const { t } = useTranslation();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const serverLines = () => version.lines.map((line) => ({ ...line, quantity: String(line.quantity) }));
  const [lines, setLines] = useState<EditLine[]>(serverLines);
  const [quoteDiscount, setQuoteDiscount] = useState(version.quoteDiscountPct);
  const [dirty, setDirty] = useState(false);
  // The lockVersion the lines on screen are based on; saves send it back (optimistic lock).
  const [baseLock, setBaseLock] = useState(lockVersion);
  const [handledConflict, setHandledConflict] = useState<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    setDirty(!fetcher.data.ok); // keep edits after an error
  }, [fetcher.state, fetcher.data]);

  const isConflict = !!fetcher.data && !fetcher.data.ok && fetcher.data.error.key === "quote.errors.changedByOther";
  const conflict = isConflict && fetcher.data !== handledConflict;
  const loadLatest = () => {
    setLines(serverLines());
    setQuoteDiscount(version.quoteDiscountPct);
    setDirty(false);
    setBaseLock(lockVersion);
    setHandledConflict(fetcher.data);
  };
  // The quote changed on the server (our own save, or someone else's while we had no edits): show it.
  // With unsaved edits we keep them, so the next save fails with changedByOther instead of losing them.
  if (lockVersion !== baseLock && !dirty && !conflict) loadLatest();

  const update = (index: number, field: "quantity" | "overridePrice" | "discountPct", value: string) => {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, [field]: value } : line)));
    setDirty(true);
  };
  const remove = (index: number) => {
    setLines((current) => current.filter((_, i) => i !== index));
    setDirty(true);
  };
  const addProducts = async () => {
    // B-9: active, published products only, no gift cards (the server checks again).
    // A product picker, not a variant one: the variant picker shows only variant titles, so
    // single-variant products ("Default Title") appeared as blank rows.
    const products = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      filter: { archived: false, draft: false, variants: true, query: "gift_card:false" },
    });
    const picked = (products ?? []).flatMap((product) =>
      product.variants.flatMap((variant) => {
        if (!variant.id) return [];
        // Not displayName: it is "Product - Default Title" for single-variant products.
        const title = variant.title && variant.title !== "Default Title" ? `${product.title} - ${variant.title}` : product.title;
        return [{ id: variant.id, title, sku: variant.sku ?? "" }];
      }),
    );
    if (!picked.length) return;
    setLines((current) => [
      ...current,
      ...picked
        .filter((variant) => !current.some((line) => line.variantId === variant.id))
        .map((variant) => ({
          variantId: variant.id,
          title: variant.title,
          sku: variant.sku ?? "",
          quantity: "1",
          overridePrice: "",
          discountPct: "",
          catalogPrice: "",
          lineTotal: "",
          problems: [],
        })),
    ]);
    setDirty(true);
  };
  const invalid =
    lines.some((line) => quantityError(line.quantity) || decimalError(line.overridePrice) || decimalError(line.discountPct, 100)) ||
    decimalError(quoteDiscount, 100);
  const save = (basedOn: number) =>
    fetcher.submit(
      {
        intent: "saveLines",
        lockVersion: String(basedOn),
        quoteDiscountPct: quoteDiscount,
        lines: JSON.stringify(
          lines.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
            overridePrice: line.overridePrice,
            discountPct: line.discountPct,
          })),
        ),
      },
      { method: "post", action: `/app/quotes/${quoteId}` },
    );

  return (
    <s-section heading={t("quote.lines.title")}>
      <s-stack direction="block" gap="base">
        <ErrorBanner result={isConflict ? null : fetcher.data} />
        {conflict && (
          <s-banner tone="warning" heading={t("quote.lines.conflict.heading")}>
            <s-paragraph>{t("quote.lines.conflict.body")}</s-paragraph>
            <s-button slot="secondary-actions" onClick={loadLatest}>
              {t("quote.lines.conflict.reload")}
            </s-button>
            {editable && (
              <s-button slot="secondary-actions" onClick={() => save(lockVersion)}>
                {t("quote.lines.conflict.overwrite")}
              </s-button>
            )}
          </s-banner>
        )}
        {version.locked && <s-text color="subdued">{t("quote.lines.locked")}</s-text>}
        {lines.length === 0 ? (
          <s-paragraph>{t("quote.lines.empty")}</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("quote.lines.product")}</s-table-header>
              <s-table-header listSlot="labeled">{t("quote.lines.quantity")}</s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                {t("quote.lines.catalogPrice")}
              </s-table-header>
              <s-table-header listSlot="labeled">{t("quote.lines.overridePrice")}</s-table-header>
              <s-table-header listSlot="labeled">{t("quote.lines.discount")}</s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                {t("quote.lines.lineTotal")}
              </s-table-header>
              {editable && <s-table-header listSlot="inline">{t("quote.lines.actions")}</s-table-header>}
            </s-table-header-row>
            <s-table-body>
              {lines.map((line, index) => (
                <s-table-row key={line.variantId}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-100">
                      <s-text>{line.title}</s-text>
                      {line.sku && <s-text color="subdued">{line.sku}</s-text>}
                      {line.problems.map((problem) => (
                        <s-text key={problem} tone={BLOCKING.includes(problem) ? "critical" : "caution"}>
                          {t(`problems.${problem}`)}
                        </s-text>
                      ))}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {editable ? (
                      <s-number-field
                        label={t("quote.lines.quantityFor", { product: line.title })}
                        labelAccessibilityVisibility="exclusive"
                        value={line.quantity}
                        min={1}
                        max={100000}
                        step={1}
                        error={quantityError(line.quantity) ? t("quote.lines.quantityError") : undefined}
                        onInput={(event) => update(index, "quantity", event.currentTarget.value)}
                      ></s-number-field>
                    ) : (
                      line.quantity
                    )}
                  </s-table-cell>
                  <s-table-cell>{line.catalogPrice || t("quote.lines.afterSave")}</s-table-cell>
                  <s-table-cell>
                    {editable ? (
                      <s-number-field
                        label={t("quote.lines.overrideFor", { product: line.title })}
                        labelAccessibilityVisibility="exclusive"
                        value={line.overridePrice}
                        min={0}
                        step={0.01}
                        prefix={currency}
                        error={decimalError(line.overridePrice) ? t("quote.lines.priceError") : undefined}
                        onInput={(event) => update(index, "overridePrice", event.currentTarget.value)}
                      ></s-number-field>
                    ) : (
                      line.overridePrice || "—"
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {editable ? (
                      <s-number-field
                        label={t("quote.lines.discountFor", { product: line.title })}
                        labelAccessibilityVisibility="exclusive"
                        value={line.discountPct}
                        min={0}
                        max={100}
                        step={0.1}
                        suffix="%"
                        error={decimalError(line.discountPct, 100) ? t("quote.lines.discountError") : undefined}
                        onInput={(event) => update(index, "discountPct", event.currentTarget.value)}
                      ></s-number-field>
                    ) : line.discountPct ? (
                      `${line.discountPct} %`
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
                  <s-table-cell>{dirty ? t("quote.lines.afterSave") : line.lineTotal}</s-table-cell>
                  {editable && (
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        icon="delete"
                        accessibilityLabel={t("quote.lines.removeFor", { product: line.title })}
                        onClick={() => remove(index)}
                      ></s-button>
                    </s-table-cell>
                  )}
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}

        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-box>
            {editable ? (
              <s-number-field
                label={t("quote.lines.quoteDiscount")}
                value={quoteDiscount}
                min={0}
                max={100}
                step={0.1}
                suffix="%"
                error={decimalError(quoteDiscount, 100) ? t("quote.lines.discountError") : undefined}
                onInput={(event) => {
                  setQuoteDiscount(event.currentTarget.value);
                  setDirty(true);
                }}
              ></s-number-field>
            ) : (
              quoteDiscount && <s-text>{t("quote.lines.quoteDiscountValue", { value: quoteDiscount })}</s-text>
            )}
          </s-box>
          <s-stack direction="block" gap="small-200">
            <s-text>{t("quote.totals.list", { amount: version.listTotal })}</s-text>
            <s-text>{t("quote.totals.discounts", { amount: version.discountTotal })}</s-text>
            <s-text type="strong">{t("quote.totals.total", { amount: version.total })}</s-text>
            {dirty && <s-text color="subdued">{t("quote.totals.unsaved")}</s-text>}
          </s-stack>
        </s-grid>

        {editable && (
          <s-stack direction="inline" gap="base">
            <s-button onClick={addProducts}>{t("quote.lines.add")}</s-button>
            <s-button
              variant="primary"
              onClick={() => save(baseLock)}
              disabled={!dirty || invalid}
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              {t("quote.lines.save")}
            </s-button>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

function ApprovalSection({
  approval,
  onDecide,
  busy,
}: {
  approval: NonNullable<LoaderData["approval"]>;
  onDecide: (intent: string, fields: Record<string, string>) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [comment, setComment] = useState("");
  return (
    <s-section heading={t("quote.approval.title")}>
      <s-stack direction="block" gap="base">
        {approval.requestedBy && <s-text>{t("quote.approval.requestedBy", { name: approval.requestedBy })}</s-text>}
        <s-unordered-list>
          {approval.reasons.map((reason) => (
            <s-list-item key={reason.code}>{t(`approval.reasons.${reason.code}`, { detail: reason.detail })}</s-list-item>
          ))}
        </s-unordered-list>
        <s-text-area
          label={t("quote.approval.comment")}
          details={t("quote.approval.commentHelp")}
          value={comment}
          maxLength={2000}
          onInput={(event) => setComment(event.currentTarget.value)}
        ></s-text-area>
        <s-stack direction="inline" gap="base">
          <s-button variant="primary" onClick={() => onDecide("approve", { comment })} {...(busy ? { loading: true } : {})}>
            {t("quote.approval.approve")}
          </s-button>
          <s-button tone="critical" onClick={() => onDecide("reject", { comment })} {...(busy ? { loading: true } : {})}>
            {t("quote.approval.reject")}
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function SendSection({ onSend, busy, syncing }: { onSend: (message: string) => void; busy: boolean; syncing: boolean }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  return (
    <s-section heading={t("quote.send.title")}>
      <s-stack direction="block" gap="base">
        <s-paragraph>{t("quote.send.help")}</s-paragraph>
        <s-text-area
          label={t("quote.send.message")}
          value={message}
          maxLength={5000}
          rows={4}
          onInput={(event) => setMessage(event.currentTarget.value)}
        ></s-text-area>
        <s-button variant="primary" onClick={() => onSend(message)} disabled={syncing} {...(busy ? { loading: true } : {})}>
          {t("quote.send.button")}
        </s-button>
      </s-stack>
    </s-section>
  );
}

function ShopifySection({ data, onRetry, busy }: { data: LoaderData; onRetry: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const { quote, shopify, perms } = data;
  const retryable =
    perms.retry && ["FAILED", "NEEDS_ATTENTION"].includes(quote.syncStatus) && ["APPROVED", "SENT"].includes(quote.status);
  return (
    <s-section heading={t("quote.shopify.title")}>
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={quote.syncStatus === "SYNCED" ? "success" : quote.syncStatus === "NONE" ? "neutral" : "warning"}>
            {t(`sync.status.${quote.syncStatus}`)}
          </s-badge>
          {quote.draftOrderNumericId && (
            <s-link href={`shopify://admin/draft_orders/${quote.draftOrderNumericId}`} target="_top">
              {t("quote.shopify.openDraft")}
            </s-link>
          )}
          {quote.orderNumericId && (
            <s-link href={`shopify://admin/orders/${quote.orderNumericId}`} target="_top">
              {shopify?.orderName ? t("quote.shopify.openOrderNamed", { name: shopify.orderName }) : t("quote.shopify.openOrder")}
            </s-link>
          )}
        </s-stack>
        {shopify?.invoiceSentAt && <s-text>{t("quote.shopify.invoiceSent", { date: shopify.invoiceSentAt })}</s-text>}
        {shopify && (
          <s-text>{t("quote.shopify.final", { subtotal: shopify.subtotal, tax: shopify.tax, total: shopify.total })}</s-text>
        )}
        {retryable && (
          <s-box>
            <s-button onClick={onRetry} {...(busy ? { loading: true } : {})}>
              {t("quote.shopify.retry")}
            </s-button>
          </s-box>
        )}
      </s-stack>
    </s-section>
  );
}

function VersionsSection({
  versions,
  onPdf,
}: {
  versions: LoaderData["versions"];
  onPdf: (versionNumber: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <s-section heading={t("quote.versions.title")}>
      <s-stack direction="block" gap="base">
        {[...versions].reverse().map((item) => (
          <s-stack key={item.number} direction="block" gap="small-200">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-text type="strong">
                {t("quote.versions.row", { number: item.number, date: item.created, total: item.total })}
                {item.author ? ` · ${item.author}` : ""}
              </s-text>
              <s-button
                variant="tertiary"
                accessibilityLabel={t("quote.versions.pdfFor", { number: item.number })}
                onClick={() => onPdf(item.number)}
              >
                {t("quote.versions.pdf")}
              </s-button>
            </s-stack>
            {item.number > 1 &&
              (item.changes.length === 0 ? (
                <s-text color="subdued">{t("quote.versions.noChanges")}</s-text>
              ) : (
                <s-unordered-list>
                  {item.changes.map((change) => (
                    <s-list-item key={change.variantId}>
                      {t(`quote.versions.${change.change}`, {
                        title: change.title,
                        beforeQty: change.before?.quantity ?? "",
                        afterQty: change.after?.quantity ?? "",
                        beforePrice: change.before?.unitPrice ?? "",
                        afterPrice: change.after?.unitPrice ?? "",
                        beforeDiscount: change.before?.discountPct ?? "0",
                        afterDiscount: change.after?.discountPct ?? "0",
                      })}
                    </s-list-item>
                  ))}
                </s-unordered-list>
              ))}
          </s-stack>
        ))}
      </s-stack>
    </s-section>
  );
}

function HistorySection({ history }: { history: LoaderData["history"] }) {
  const { t } = useTranslation();
  return (
    <s-section heading={t("quote.history.title")}>
      <s-unordered-list>
        {[...history].reverse().map((event) => (
          <s-list-item key={event.id}>
            {t("quote.history.row", {
              at: event.at,
              who: event.actor ?? t(`quote.history.actors.${event.actorType}`),
              what: t(`history.${event.action}`, { defaultValue: event.action }),
            })}
          </s-list-item>
        ))}
      </s-unordered-list>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
