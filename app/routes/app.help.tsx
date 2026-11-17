import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getActor } from "../models/actor.server";

// Help (M6.4): links into the public help center (/help) and a prefilled support email.
const SUPPORT_EMAIL = "adhurimberisha07@gmail.com";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  // eslint-disable-next-line no-undef
  const version = process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "dev";
  // Support code: enough to find the shop in logs and Sentry, no personal data.
  return { supportCode: `${actor.shop} · ${actor.role} · ${version}` };
};

const SECTIONS = ["getting-started", "quotes", "csv", "approvals", "sending", "customer-accounts", "quote-requests", "troubleshooting"] as const;

export default function Help() {
  const { supportCode } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const subject = encodeURIComponent(t("help.support.subject", { code: supportCode }));
  const body = encodeURIComponent(t("help.support.body", { code: supportCode }));

  return (
    <s-page heading={t("help.title")}>
      <s-section heading={t("help.docs.title")}>
        <s-stack direction="block" gap="small-200">
          {SECTIONS.map((id) => (
            <s-link key={id} href={`/help#${id}`} target="_blank">
              {t(`help.docs.sections.${id}`)}
            </s-link>
          ))}
        </s-stack>
      </s-section>
      <s-section heading={t("help.support.title")}>
        <s-stack direction="block" gap="base">
          <s-paragraph>{t("help.support.help", { email: SUPPORT_EMAIL })}</s-paragraph>
          <s-text color="subdued">{t("help.support.code", { code: supportCode })}</s-text>
          <s-button variant="primary" href={`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`} target="_blank">
            {t("help.support.button")}
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
