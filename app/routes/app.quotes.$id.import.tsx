import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigate, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import db from "../db.server";
import { type ActionResult, runAction } from "../lib/action.server";
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
  const form = await request.formData();

  return runAction(async () => {
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

// ponytail: shows raw translation keys and row codes until app/locales arrives in M2.8.
const errorText = (result: ActionResult<unknown> | undefined) => {
  if (!result || result.ok) return null;
  const params = Object.entries(result.error.params).map(([k, v]) => `${k}: ${v}`);
  return [result.error.key, ...params].join(" · ");
};

// Browser download of text we already have (embedded pages can't download from an
// authenticated URL with a plain link).
const downloadText = (fileName: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

const STATUS_TONE: Record<RowStatus, "success" | "warning" | "critical" | "info"> = {
  OK: "success",
  WARNING: "warning",
  ERROR: "critical",
  MERGED: "info",
};

export default function ImportPage() {
  const { quoteId, label, locked, imp, report, reportCsv } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const dropZone = useRef<HTMLElementTagNameMap["s-drop-zone"]>(null);
  const [filter, setFilter] = useState<RowStatus | "ALL">("ALL");
  const busy = fetcher.state !== "idle" ? { loading: true } : {};
  const error = errorText(fetcher.data);

  // After upload: show the import; after commit: back to the quotes.
  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result?.ok) return;
    navigate(result.data.committed ? "/app" : `/app/quotes/${quoteId}/import?import=${result.data.importId}`);
  }, [fetcher.state, fetcher.data, navigate, quoteId]);

  // Big files are validated in the background: refresh every 2 s.
  const validating = imp?.status === "VALIDATING";
  useEffect(() => {
    if (!validating) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2000);
    return () => clearInterval(timer);
  }, [validating, revalidator]);

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
    <s-page heading={`Import lines into ${label}`}>
      <s-link slot="breadcrumb-actions" href="/app">
        Quotes
      </s-link>
      {locked && (
        <s-banner tone="warning" heading="This version is locked">
          Revise the quote to get an editable version, then import.
        </s-banner>
      )}
      {error && <s-banner tone="critical">{error}</s-banner>}

      {showUpload && !locked && (
        <s-section heading="Upload a CSV file">
          <s-stack direction="block" gap="base">
            {imp?.status === "FAILED" && (
              <s-banner tone="critical" heading="The last file could not be checked">
                {imp.error}
              </s-banner>
            )}
            <s-paragraph>
              Columns: sku and quantity (required), price and discount (optional). Comma or
              semicolon separated, up to 10,000 rows and 5 MB. Repeated SKUs are merged.
            </s-paragraph>
            <s-drop-zone ref={dropZone} label="CSV file" name="file" accept=".csv,text/csv"></s-drop-zone>
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" onClick={upload} {...busy}>
                Check file
              </s-button>
              <s-button variant="tertiary" onClick={() => downloadText("vendora-import-template.csv", TEMPLATE_CSV)}>
                Download template
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      {validating && imp && (
        <s-section heading={imp.fileName}>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-spinner accessibilityLabel="Checking the file"></s-spinner>
            <s-text>Checking {imp.rowCount} rows…</s-text>
          </s-stack>
        </s-section>
      )}

      {imp?.status === "READY" && report && (
        <s-section heading={imp.fileName}>
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-200">
              <s-badge tone="success">{report.summary.lines} lines to add</s-badge>
              <s-badge tone="warning">{report.summary.warnings} warnings</s-badge>
              <s-badge tone="critical">{report.summary.errors} errors</s-badge>
              <s-badge tone="info">{report.summary.merged} merged rows</s-badge>
            </s-stack>
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
              <s-select
                label="Show"
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value as RowStatus | "ALL")}
              >
                <s-option value="ALL">All rows</s-option>
                <s-option value="ERROR">Errors</s-option>
                <s-option value="WARNING">Warnings</s-option>
                <s-option value="MERGED">Merged</s-option>
                <s-option value="OK">OK</s-option>
              </s-select>
              <s-button
                variant="tertiary"
                onClick={() => reportCsv && downloadText(`${imp.fileName.replace(/\.csv$/i, "")}-report.csv`, reportCsv)}
              >
                Download report (CSV)
              </s-button>
            </s-grid>
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="kicker">Row</s-table-header>
                <s-table-header listSlot="primary">SKU</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header listSlot="labeled">Messages</s-table-header>
                <s-table-header listSlot="labeled">Detail</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((row) => (
                  <s-table-row key={row.row}>
                    <s-table-cell>{row.row}</s-table-cell>
                    <s-table-cell>{row.sku || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={STATUS_TONE[row.status]}>{row.status}</s-badge>
                    </s-table-cell>
                    <s-table-cell>{row.codes.join(", ")}</s-table-cell>
                    <s-table-cell>{row.detail ?? ""}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="commit" />
              <input type="hidden" name="importId" value={imp.id} />
              <s-stack direction="block" gap="base">
                <s-choice-list label="How to add the lines" name="mode">
                  <s-choice value="append" defaultSelected>
                    Add to the existing lines (same product: quantities are added)
                  </s-choice>
                  <s-choice value="replace">Replace all existing lines</s-choice>
                </s-choice-list>
                <s-button type="submit" variant="primary" disabled={report.summary.lines === 0 || locked} {...busy}>
                  Add {report.summary.lines} lines
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
