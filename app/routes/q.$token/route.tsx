import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import { localDateString } from "../../lib/dates";
import { createI18n } from "../../lib/i18n";
import { formatMoney } from "../../lib/money";
import { PUBLIC_HEADERS, findPublicQuote, recordView } from "../../models/public-quote.server";
import styles from "./styles.module.css";

// ponytail: English only until a second language exists; then the contact's locale.
const LOCALE = "en";

// Public quote page behind a signed link (M3.2). Outside the Shopify admin: plain HTML, no Polaris.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const token = params.token ?? "";
  const { quote, version, shop, superseded } = await findPublicQuote(request, token);
  const label = `${shop.quotePrefix}${quote.number}`;
  if (superseded) {
    return data({ superseded, label, version: version.versionNumber, quote: null }, { headers: PUBLIC_HEADERS });
  }

  await recordView(quote, version.versionNumber);
  const money = (value: Parameters<typeof formatMoney>[0]) => formatMoney(value, quote.currencyCode, LOCALE);
  // Customer-visible data only: no internal notes, rep ids or attention items.
  return data(
    {
      superseded,
      label,
      version: version.versionNumber,
      quote: {
        expiresAt: quote.expiresAt ? localDateString(quote.expiresAt, shop.timezone) : null,
        lines: version.lines.map((line) => ({
          id: line.id,
          title: line.titleSnapshot,
          sku: line.sku ?? "",
          quantity: line.quantity,
          unitPrice: money(line.overridePrice ?? line.catalogPrice),
          discount: line.discountPct && !line.discountPct.isZero() ? `${line.discountPct.toString()} %` : "",
          lineTotal: money(line.lineTotal),
        })),
        total: money(version.total),
        note: version.note,
        pdfUrl: `/q/${token}/pdf`,
        // Shopify's checkout link, only while the quote is waiting for the buyer.
        invoiceUrl: quote.status === "SENT" ? quote.invoiceUrl : null,
      },
    },
    { headers: PUBLIC_HEADERS },
  );
};

// errorHeaders: a thrown 404/429 (with PUBLIC_HEADERS) renders this route's ErrorBoundary; keep its headers.
export const headers: HeadersFunction = ({ loaderHeaders, errorHeaders }) => errorHeaders ?? loaderHeaders;

export const ErrorBoundary = () => {
  const error = useRouteError();
  const { t } = createI18n(LOCALE);
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const key = status === 404 ? "notFound" : status === 429 ? "rateLimited" : "failed";
  return (
    <div className={styles.page} lang={LOCALE}>
      <main className={styles.main}>
        <p role="alert">{t(`publicQuote.errors.${key}`)}</p>
      </main>
    </div>
  );
};

export const meta: MetaFunction = () => [{ name: "robots", content: "noindex" }];

export default function PublicQuote() {
  const { superseded, label, version, quote } = useLoaderData<typeof loader>();
  const { t } = createI18n(LOCALE);

  return (
    <div className={styles.page} lang={LOCALE}>
      <a className={styles.skip} href="#main">
        {t("publicQuote.skip")}
      </a>
      <main id="main" className={styles.main}>
        <h1>{t("publicQuote.title", { number: label, version })}</h1>
        {superseded || !quote ? (
          <p role="status">{t("publicQuote.superseded")}</p>
        ) : (
          <>
            {quote.expiresAt && <p>{t("publicQuote.validUntil", { date: quote.expiresAt })}</p>}
            {/* Also above the table: on a phone the table scrolls sideways and hides the total column. */}
            <p className={styles.summaryTotal}>
              {t("publicQuote.total")}: {quote.total}
            </p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>{t("publicQuote.linesCaption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("pdf.sku")}</th>
                    <th scope="col">{t("pdf.product")}</th>
                    <th scope="col" className={styles.num}>{t("pdf.qty")}</th>
                    <th scope="col" className={styles.num}>{t("pdf.unitPrice")}</th>
                    <th scope="col" className={styles.num}>{t("pdf.discount")}</th>
                    <th scope="col" className={styles.num}>{t("pdf.lineTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.sku}</td>
                      <td>{line.title}</td>
                      <td className={styles.num}>{line.quantity}</td>
                      <td className={styles.num}>{line.unitPrice}</td>
                      <td className={styles.num}>{line.discount}</td>
                      <td className={styles.num}>{line.lineTotal}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={5}>{t("publicQuote.total")}</th>
                    <td className={styles.num}>{quote.total}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {quote.note && (
              <section aria-labelledby="note-heading">
                <h2 id="note-heading">{t("publicQuote.note")}</h2>
                <p className={styles.note}>{quote.note}</p>
              </section>
            )}
            <p className={styles.actions}>
              <a href={quote.pdfUrl} download>
                {t("publicQuote.downloadPdf")}
              </a>
              {quote.invoiceUrl && (
                <a className={styles.primary} href={quote.invoiceUrl} rel="noreferrer">
                  {t("publicQuote.accept")}
                </a>
              )}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
