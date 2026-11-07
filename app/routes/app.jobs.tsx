import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import ErrorBanner from "../components/ErrorBanner";
import { runAction } from "../lib/action.server";
import { formatDateTime } from "../lib/dates";
import { parseForm } from "../lib/validation";
import { getActor } from "../models/actor.server";
import { listFailedJobs, retryFailedJob } from "../models/jobs.server";
import { quoteLabel } from "../models/quote.server";
import { getShop } from "../models/shop.server";
import db from "../db.server";

// Jobs (M4.2, OWNER/MANAGER): this shop's background work that failed every retry.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  const [jobs, shop] = await Promise.all([listFailedJobs(actor), getShop(actor.shop)]); // listFailedJobs checks jobs.retry
  const quoteIds = [...new Set(jobs.flatMap((job) => (job.quoteId ? [job.quoteId] : [])))];
  const quotes = await db.quote.findMany({ where: { shop: actor.shop, id: { in: quoteIds } }, select: { id: true, number: true } });
  const numbers = new Map(quotes.map((quote) => [quote.id, quote.number]));
  return {
    jobs: jobs.map((job) => {
      const number = job.quoteId ? numbers.get(job.quoteId) : undefined;
      return {
        ...job,
        quoteLabel: number === undefined ? null : quoteLabel(shop?.quotePrefix ?? "Q-", number),
        failedAt: formatDateTime(new Date(job.failedAt), actor.locale, shop?.timezone ?? "UTC"),
      };
    }),
  };
};

const retrySchema = z.object({ queue: z.string().max(40), jobId: z.uuid() });

export const action = async ({ request }: ActionFunctionArgs) => {
  const actor = await getActor(request);
  const form = await request.formData();
  return runAction(async () => {
    const input = parseForm(form, retrySchema);
    await retryFailedJob(actor, input.queue, input.jobId);
    return { retried: input.jobId };
  });
};

export default function Jobs() {
  const { jobs } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const fetcher = useFetcher<typeof action>();

  return (
    <s-page heading={t("jobs.title")}>
      <s-stack direction="block" gap="base">
        <ErrorBanner result={fetcher.data} />
        <s-section>
          {jobs.length === 0 ? (
            <s-paragraph>{t("jobs.empty")}</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">{t("jobs.columns.queue")}</s-table-header>
                <s-table-header listSlot="secondary">{t("jobs.columns.quote")}</s-table-header>
                <s-table-header listSlot="labeled">{t("jobs.columns.error")}</s-table-header>
                <s-table-header listSlot="labeled">{t("jobs.columns.attempts")}</s-table-header>
                <s-table-header listSlot="labeled">{t("jobs.columns.failedAt")}</s-table-header>
                <s-table-header listSlot="inline">{t("jobs.columns.action")}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {jobs.map((job) => (
                  <s-table-row key={job.id}>
                    <s-table-cell>{t(`jobs.queues.${job.queue}`)}</s-table-cell>
                    <s-table-cell>
                      {job.quoteId && job.quoteLabel ? <s-link href={`/app/quotes/${job.quoteId}`}>{job.quoteLabel}</s-link> : "–"}
                    </s-table-cell>
                    <s-table-cell>{job.error || "–"}</s-table-cell>
                    <s-table-cell>{job.attempts}</s-table-cell>
                    <s-table-cell>{job.failedAt}</s-table-cell>
                    <s-table-cell>
                      <fetcher.Form method="post">
                        <input type="hidden" name="queue" value={job.queue} />
                        <input type="hidden" name="jobId" value={job.id} />
                        <s-button
                          type="submit"
                          accessibilityLabel={t("jobs.retryLabel", { queue: t(`jobs.queues.${job.queue}`) })}
                          {...(fetcher.state !== "idle" && fetcher.formData?.get("jobId") === job.id ? { loading: true } : {})}
                        >
                          {t("jobs.retry")}
                        </s-button>
                      </fetcher.Form>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
