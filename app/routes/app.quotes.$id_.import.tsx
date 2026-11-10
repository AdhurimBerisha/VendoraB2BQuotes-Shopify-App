import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import ErrorBanner from "../components/ErrorBanner";
import usePollWhile from "../components/usePollWhile";
import db from "../db.server";
import { runAction } from "../lib/action.server";
import { downloadText } from "../lib/download";
import { NotFoundError, UserError } from "../lib/errors";
import { parseForm } from "../lib/validation";
import { getActor } from "../models/actor.server";
import { type ImportReport, type RowStatus, commitImport, reportToCsv, startImport } from "../models/import.server";
import { requirePermission } from "../models/permissions";
import { quoteLabel } from "../models/quote.server";
import { getShop } from "../models/shop.server";

const TEMPLATE_CSV = "sku,quantity,price,discount\n";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "import.run");
  const quote = await db.quote.findFirst({
    where: { id: params.id, shop: actor.shop },
    include: { currentVersion: { select: { lockedAt: true } } },
  });
  if (!quote) throw new NotFoundError();
  const importId = new URL(request.url).searchParams.get("import");
  const imp = importId
    ? await db.import.findFirst({ where: { id: importId, shop: actor.shop, quoteId: quote.id } })
    : null;
  const report = (imp?.report as ImportReport | null) ?? null;
  const prefix = (await getShop(actor.shop))?.quotePrefix ?? "Q-";

  return {
    quoteId: quote.id,
    label: quoteLabel(prefix, quote.number),
    locked: !!quote.currentVersion?.lockedAt,
    imp: imp && { id: imp.id, status: imp.status, fileName: imp.fileName, rowCount: imp.rowCount, error: imp.error },
    report,
    reportCsv: report ? reportToCsv(report) : null,
  };
};

const commitSchema = z.object({
  intent: z.literal("commit"),
  importId: z.string().min(1),
  mode: z.enum(["append", "replace"]),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const actor = await getActor(request);

  return runAction(async () => {
    // Refuse a big body before formData() reads it into memory; startImport checks the file (5 MB).
    if (Number(request.headers.get("content-length")) > 6 * 1024 * 1024) {
      throw new UserError("import.errors.tooLarge", { maxMb: 5 });
    }
    const form = await request.formData();
    if (form.get("intent") === "upload") {
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) throw new UserError("import.errors.noFile");
      const imp = await startImport(actor, params.id ?? "", file);
      return { importId: imp.id, committed: false };
    }
    const { importId, mode } = parseForm(form, commitSchema);
    await commitImport(actor, importId, mode);
    return { importId, committed: true };
  });
};

const STATUS_TONE: Record<RowStatus, "success" | "warning" | "critical" | "info"> = {
  OK: "success",
  WARNING: "warning",
  ERROR: "critical",
  MERGED: "info",
};

export default function ImportPage() {
  const { quoteId, label, locked, imp, report, reportCsv } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const dropZone = useRef<HTMLElementTagNameMap["s-drop-zone"]>(null);
  const [filter, setFilter] = useState<RowStatus | "ALL">("ALL");
  const busy = fetcher.state !== "idle" ? { loading: true } : {};

  // After upload: show the import; after commit: back to the quote.
  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result?.ok) return;
    navigate(result.data.committed ? `/app/quotes/${quoteId}` : `/app/quotes/${quoteId}/import?import=${result.data.importId}`);
  }, [fetcher.state, fetcher.data, navigate, quoteId]);

  // Big files are validated in the background.
  const validating = imp?.status === "VALIDATING";
  usePollWhile(validating, 2000);

  const upload = () => {
    const file = dropZone.current?.files?.[0];
    const form = new FormData();
    form.set("intent", "upload");
    if (file) form.set("file", file);
    fetcher.submit(form, { method: "post", encType: "multipart/form-data" });
  };

  const rows = report?.rows.filter((row) => filter === "ALL" || row.status === filter) ?? [];
  const showUpload = !imp || imp.status === "FAILED" || imp.status === "COMMITTED";

  return (
    <s-page heading={t("import.title", { label })}>
      <s-link slot="breadcrumb-actions" href={`/app/quotes/${quoteId}`}>
        {label}
      </s-link>
      {locked && (
        <s-banner tone="warning" heading={t("import.locked.heading")}>
          {t("import.locked.body")}
        </s-banner>
      )}
      <ErrorBanner result={fetcher.data} />

      {showUpload && !locked && (
        <s-section heading={t("import.upload.title")}>
          <s-stack direction="block" gap="base">
            {imp?.status === "FAILED" && (
              <s-banner tone="critical" heading={t("import.upload.failed")}>
                {imp.error}
              </s-banner>
            )}
            <s-paragraph>{t("import.upload.help")}</s-paragraph>
            <s-drop-zone ref={dropZone} label={t("import.upload.file")} name="file" accept=".csv,text/csv"></s-drop-zone>
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" onClick={upload} {...busy}>
                {t("import.upload.check")}
              </s-button>
              <s-button variant="tertiary" onClick={() => downloadText(TEMPLATE_CSV, "vendora-import-template.csv")}>
                {t("import.upload.template")}
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      {validating && imp && (
        <s-section heading={imp.fileName}>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-spinner accessibilityLabel={t("import.checking.label")}></s-spinner>
            <s-text>{t("import.checking.rows", { count: imp.rowCount })}</s-text>
          </s-stack>
        </s-section>
      )}

      {imp?.status === "READY" && report && (
        <s-section heading={imp.fileName}>
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-200">
              <s-badge tone="success">{t("import.summary.lines", { count: report.summary.lines })}</s-badge>
              <s-badge tone="warning">{t("import.summary.warnings", { count: report.summary.warnings })}</s-badge>
              <s-badge tone="critical">{t("import.summary.errors", { count: report.summary.errors })}</s-badge>
              <s-badge tone="info">{t("import.summary.merged", { count: report.summary.merged })}</s-badge>
            </s-stack>
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
              <s-select
                label={t("import.report.show")}
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value as RowStatus | "ALL")}
              >
                <s-option value="ALL">{t("import.report.all")}</s-option>
                {(["ERROR", "WARNING", "MERGED", "OK"] as const).map((status) => (
                  <s-option key={status} value={status}>
                    {t(`import.rowStatus.${status}`)}
                  </s-option>
                ))}
              </s-select>
              <s-button
                variant="tertiary"
                onClick={() => reportCsv && downloadText(reportCsv, `${imp.fileName.replace(/\.csv$/i, "")}-report.csv`)}
              >
                {t("import.report.download")}
              </s-button>
            </s-grid>
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="kicker">{t("import.report.row")}</s-table-header>
                <s-table-header listSlot="primary">{t("import.report.sku")}</s-table-header>
                <s-table-header listSlot="inline">{t("import.report.status")}</s-table-header>
                <s-table-header listSlot="labeled">{t("import.report.messages")}</s-table-header>
                <s-table-header listSlot="labeled">{t("import.report.detail")}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((row) => (
                  <s-table-row key={row.row}>
                    <s-table-cell>{row.row}</s-table-cell>
                    <s-table-cell>{row.sku || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={STATUS_TONE[row.status]}>{t(`import.rowStatus.${row.status}`)}</s-badge>
                    </s-table-cell>
                    <s-table-cell>{row.codes.map((code) => t(`import.codes.${code}`)).join(" · ")}</s-table-cell>
                    <s-table-cell>{row.detail ?? ""}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="commit" />
              <input type="hidden" name="importId" value={imp.id} />
              <s-stack direction="block" gap="base">
                <s-choice-list label={t("import.commit.mode")} name="mode">
                  <s-choice value="append" defaultSelected>
                    {t("import.commit.append")}
                  </s-choice>
                  <s-choice value="replace">{t("import.commit.replace")}</s-choice>
                </s-choice-list>
                <s-button type="submit" variant="primary" disabled={report.summary.lines === 0 || locked} {...busy}>
                  {t("import.commit.button", { count: report.summary.lines })}
                </s-button>
              </s-stack>
            </fetcher.Form>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
