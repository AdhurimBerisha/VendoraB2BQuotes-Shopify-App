import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Prisma } from "@prisma/client";
import StatusBadge from "../components/StatusBadge";
import db from "../db.server";
import { formatDate, startOfMonthInTz } from "../lib/dates";
import { getActor } from "../models/actor.server";
import { attentionItems } from "../models/attention";
import { can, requirePermission } from "../models/permissions";
import { quoteLabel } from "../models/quote.server";
import { getShop } from "../models/shop.server";

const EXPIRING_DAYS = 3;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "quote.view");
  const shop = await getShop(actor.shop);
  const prefix = shop?.quotePrefix ?? "Q-";
  const timezone = shop?.timezone ?? "UTC";
  const monthStart = startOfMonthInTz(new Date(), timezone);
  const where = { shop: actor.shop };

  const [byStatus, attention, pending, expiring, orderedThisMonth, sentThisMonth] = await Promise.all([
    db.quote.groupBy({ by: ["status"], where, _count: true }),
    db.quote.findMany({
      where: {
        ...where,
        OR: [{ syncStatus: { in: ["FAILED", "NEEDS_ATTENTION"] } }, { attention: { not: Prisma.DbNull } }],
      },
      select: { id: true, number: true, attention: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    can(actor, "quote.approve")
      ? db.quote.findMany({
          where: { ...where, status: "PENDING_APPROVAL" },
          select: { id: true, number: true, status: true },
          orderBy: { updatedAt: "asc" },
          take: 10,
        })
      : Promise.resolve([]),
    db.quote.findMany({
      where: {
        ...where,
        status: { in: ["APPROVED", "SENT"] },
        expiresAt: { lte: new Date(Date.now() + EXPIRING_DAYS * 86_400_000) },
      },
      select: { id: true, number: true, status: true, expiresAt: true },
      orderBy: { expiresAt: "asc" },
      take: 10,
    }),
    db.quote.count({ where: { ...where, status: "ORDERED", updatedAt: { gte: monthStart } } }),
    db.auditEvent.count({ where: { ...where, action: "quote.sent", createdAt: { gte: monthStart } } }),
  ]);
  const count = (status: string) => byStatus.find((row) => row.status === status)?._count ?? 0;

  return {
    metrics: {
      drafts: count("DRAFT"),
      pending: count("PENDING_APPROVAL"),
      sent: sentThisMonth,
      ordered: orderedThisMonth,
      conversion: sentThisMonth ? Math.round((orderedThisMonth / sentThisMonth) * 100) : null,
    },
    attention: attention.map((quote) => ({
      id: quote.id,
      label: quoteLabel(prefix, quote.number),
      items: attentionItems(quote.attention).map((item) => ({ code: item.code, message: item.message ?? "" })),
    })),
    pending: pending.map((quote) => ({ id: quote.id, label: quoteLabel(prefix, quote.number), status: quote.status })),
    expiring: expiring.map((quote) => ({
      id: quote.id,
      label: quoteLabel(prefix, quote.number),
      status: quote.status,
      expires: quote.expiresAt ? formatDate(quote.expiresAt, actor.locale, timezone) : "",
    })),
    canCreate: can(actor, "quote.create"),
  };
};

export default function Dashboard() {
  const { metrics, attention, pending, expiring, canCreate } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const metric = (label: string, value: string | number) => (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );

  return (
    <s-page heading={t("dashboard.title")}>
      {canCreate && (
        <s-button slot="primary-action" variant="primary" href="/app/quotes/new">
          {t("quotes.new")}
        </s-button>
      )}
      <s-section>
        <s-grid gridTemplateColumns="repeat(4, 1fr)" gap="base">
          {metric(t("dashboard.metrics.drafts"), metrics.drafts)}
          {metric(t("dashboard.metrics.pending"), metrics.pending)}
          {metric(t("dashboard.metrics.sent"), metrics.sent)}
          {metric(
            t("dashboard.metrics.ordered"),
            metrics.conversion === null
              ? metrics.ordered
              : t("dashboard.metrics.orderedWithRate", { count: metrics.ordered, rate: metrics.conversion }),
          )}
        </s-grid>
      </s-section>

      <s-section heading={t("dashboard.attention")}>
        {attention.length === 0 ? (
          <s-paragraph>{t("dashboard.allClear")}</s-paragraph>
        ) : (
          <s-unordered-list>
            {attention.map((quote) => (
              <s-list-item key={quote.id}>
                <s-link href={`/app/quotes/${quote.id}`}>{quote.label}</s-link>
                {": "}
                {quote.items.length
                  ? quote.items.map((item) => t(`attention.${item.code}`, { message: item.message })).join(" · ")
                  : t("dashboard.syncProblem")}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>

      {pending.length > 0 && (
        <s-section heading={t("dashboard.pending")}>
          <s-unordered-list>
            {pending.map((quote) => (
              <s-list-item key={quote.id}>
                <s-link href={`/app/quotes/${quote.id}`}>{quote.label}</s-link> <StatusBadge status={quote.status} />
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-section>
      )}

      <s-section heading={t("dashboard.expiring")}>
        {expiring.length === 0 ? (
          <s-paragraph>{t("dashboard.nothingExpiring")}</s-paragraph>
        ) : (
          <s-unordered-list>
            {expiring.map((quote) => (
              <s-list-item key={quote.id}>
                <s-link href={`/app/quotes/${quote.id}`}>{quote.label}</s-link>{" "}
                {t("dashboard.expiresOn", { date: quote.expires })} <StatusBadge status={quote.status} />
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
