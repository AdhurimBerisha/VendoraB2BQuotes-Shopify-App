import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// The app backend. ponytail: one constant; in dev set it to the tunnel URL `shopify app dev`
// prints (or run dev with a fixed --tunnel-url), in production to the app's real URL.
const BACKEND_URL = "https://cement-typing-host-amendments.trycloudflare.com";

// Shape of GET /api/customer/quotes (app/models/customer-quotes.server.ts).
type CustomerQuote = {
  id: string;
  label: string;
  status: "SENT" | "ORDERED" | "DECLINED" | "EXPIRED";
  total: string;
  currencyCode: string;
  expiresAt: string | null;
  invoiceUrl: string | null;
  pdfUrl: string | null;
};
type QuoteAction = "decline" | "changes";

const api = async (path: string, init: RequestInit = {}) => {
  const token = await shopify.sessionToken.get();
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error(`Vendora API ${response.status}`);
  return response.json();
};

const ReasonModal = (props: {
  id: string;
  heading: string;
  label: string;
  submit: string;
  onSubmit: (message: string) => void;
}) => {
  const [message, setMessage] = useState("");
  return (
    <s-modal id={props.id} heading={props.heading}>
      <s-text-area
        label={props.label}
        name="message"
        rows={3}
        maxLength={1000}
        value={message}
        onInput={(event: Event) => setMessage((event.currentTarget as HTMLInputElement).value)}
      ></s-text-area>
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={!message.trim()}
        commandFor={props.id}
        command="--hide"
        onClick={() => {
          props.onSubmit(message.trim());
          setMessage("");
        }}
      >
        {props.submit}
      </s-button>
    </s-modal>
  );
};

const QuotesPage = () => {
  const { translate: t, formatCurrency, formatDate } = shopify.i18n;
  const [quotes, setQuotes] = useState<CustomerQuote[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = () =>
    api("/api/customer/quotes")
      .then((data: CustomerQuote[]) => {
        setQuotes(data);
        setLoadFailed(false);
      })
      .catch((error) => {
        console.error("Vendora quotes failed to load", error);
        setLoadFailed(true);
      });

  useEffect(() => {
    load();
  }, []);

  const act = async (id: string, action: QuoteAction, message: string) => {
    try {
      await api(`/api/customer/quotes/${id}`, { method: "POST", body: JSON.stringify({ action, message }) });
      shopify.toast.show(t(action === "decline" ? "declined" : "changesSent"));
    } catch (error) {
      console.error("Vendora quote action failed", error);
      shopify.toast.show(t("actionError"));
    }
    await load();
  };

  return (
    <s-page heading={t("title")}>
      {loadFailed && <s-banner tone="critical">{t("loadError")}</s-banner>}
      {quotes === null && !loadFailed && <s-spinner accessibilityLabel={t("loading")}></s-spinner>}
      {quotes?.length === 0 && <s-paragraph>{t("empty")}</s-paragraph>}
      {quotes?.map((quote) => (
        <s-section key={quote.id} heading={quote.label}>
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={quote.status === "SENT" ? "auto" : "neutral"}>{t(`status.${quote.status}`)}</s-badge>
              {/* Code too, like Shopify's own Orders list ("$862.00 CAD"): "$" alone is ambiguous. */}
              <s-text type="strong">
                {formatCurrency(Number(quote.total), { currency: quote.currencyCode })} {quote.currencyCode}
              </s-text>
              {quote.expiresAt && (
                <s-text>{t("validUntil", { date: formatDate(new Date(quote.expiresAt)) })}</s-text>
              )}
            </s-stack>
            <s-button-group>
              {quote.status === "SENT" && quote.invoiceUrl && (
                <s-button slot="primary-action" variant="primary" href={quote.invoiceUrl}>
                  {t("accept")}
                </s-button>
              )}
              {quote.pdfUrl && (
                <s-button slot="secondary-actions" variant="secondary" href={quote.pdfUrl} target="_blank">
                  {t("downloadPdf")}
                </s-button>
              )}
              {quote.status === "SENT" && (
                <s-button slot="secondary-actions" variant="secondary" commandFor={`changes-${quote.id}`} command="--show">
                  {t("requestChanges")}
                </s-button>
              )}
              {quote.status === "SENT" && (
                <s-button slot="secondary-actions" variant="secondary" tone="critical" commandFor={`decline-${quote.id}`} command="--show">
                  {t("decline")}
                </s-button>
              )}
            </s-button-group>
          </s-stack>
          {quote.status === "SENT" && (
            <>
              <ReasonModal
                id={`changes-${quote.id}`}
                heading={t("changesTitle")}
                label={t("whatToChange")}
                submit={t("send")}
                onSubmit={(message) => act(quote.id, "changes", message)}
              />
              <ReasonModal
                id={`decline-${quote.id}`}
                heading={t("declineTitle")}
                label={t("reason")}
                submit={t("decline")}
                onSubmit={(message) => act(quote.id, "decline", message)}
              />
            </>
          )}
        </s-section>
      ))}
    </s-page>
  );
};

export default async () => {
  render(<QuotesPage />, document.body);
};
