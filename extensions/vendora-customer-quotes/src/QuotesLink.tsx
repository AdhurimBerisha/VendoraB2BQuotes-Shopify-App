import "@shopify/ui-extensions/preact";
import { render } from "preact";

// Block on the Orders page that opens the full "Quotes" page of this extension.
const QuotesLink = () => {
  const { translate: t } = shopify.i18n;
  return (
    <s-section heading={t("title")}>
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-text>{t("intro")}</s-text>
        <s-button href="extension:vendora-customer-quotes/">{t("viewQuotes")}</s-button>
      </s-stack>
    </s-section>
  );
};

export default async () => {
  render(<QuotesLink />, document.body);
};
