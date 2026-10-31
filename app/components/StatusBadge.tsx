import { useTranslation } from "react-i18next";

const TONE: Record<string, "info" | "success" | "warning" | "critical" | "neutral" | "auto"> = {
  DRAFT: "neutral",
  PENDING_APPROVAL: "warning",
  APPROVED: "info",
  SENT: "info",
  ORDERED: "success",
  DECLINED: "critical",
  EXPIRED: "neutral",
  CANCELLED: "neutral",
};

// Status as text, not colour only (a11y).
const StatusBadge = ({ status }: { status: string }) => {
  const { t } = useTranslation();
  return <s-badge tone={TONE[status] ?? "auto"}>{t(`quote.status.${status}`, { defaultValue: status })}</s-badge>;
};

export default StatusBadge;
