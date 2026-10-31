import { useTranslation } from "react-i18next";

type ActionError = { key: string; params: Record<string, string | number> };

// The translated error of a failed action (ActionResult from runAction).
const ErrorBanner = ({ result }: { result?: { ok: true } | { ok: false; error: ActionError } | null }) => {
  const { t } = useTranslation();
  if (!result || result.ok) return null;
  return <s-banner tone="critical">{t(result.error.key, { ...result.error.params, defaultValue: result.error.key })}</s-banner>;
};

export default ErrorBanner;
