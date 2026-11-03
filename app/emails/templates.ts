import type { TFunction } from "i18next";

// Staff notification emails (M3.3). Buyers get Shopify's own invoice emails instead.
const EMAIL_TYPES = [
  "approvalNeeded",
  "approved",
  "rejected",
  "quoteViewed",
  "quoteOrdered",
  "expiringSoon",
  "needsAttention",
] as const;
type EmailType = (typeof EMAIL_TYPES)[number];

// Subjects carry only the quote label: no customer personal data.
type EmailParams = {
  quoteLabel: string;
  shopName: string;
  url: string;
  actor?: string;
  comment?: string;
  reasons?: { code: string; detail?: string }[]; // approval reasons, translated per recipient
  date?: string;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Minimal accessible layout: real text, lang, high contrast, and a plain-text twin.
const layout = (o: { lang: string; title: string; paragraphs: string[]; action: { label: string; url: string }; footer: string }) => {
  const paragraphs = o.paragraphs.map((text) => `<p style="margin:0 0 12px">${escapeHtml(text)}</p>`).join("");
  const button = `<p><a href="${escapeHtml(o.action.url)}" style="background:#1a1a1a;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(o.action.label)}</a></p>`;
  const html = `<!doctype html><html lang="${escapeHtml(o.lang)}"><body style="font-family:Arial,sans-serif;color:#1a1a1a;font-size:15px;line-height:1.5">
<h1 style="font-size:18px">${escapeHtml(o.title)}</h1>${paragraphs}${button}<hr><p style="font-size:12px;color:#616161">${escapeHtml(o.footer)}</p></body></html>`;
  const text = [o.title, "", ...o.paragraphs, "", `${o.action.label}: ${o.action.url}`, "", o.footer].join("\n");
  return { html, text };
};

const renderEmail = (type: EmailType, params: EmailParams, t: TFunction, lang: string) => {
  const reasons = params.reasons?.map((reason) => t(`approval.reasons.${reason.code}`, { detail: reason.detail })).join("; ");
  const values = { ...params, reasons };
  const subject = t(`email.${type}.subject`, values);
  const paragraphs = [t(`email.${type}.body`, values), ...(params.comment ? [`"${params.comment}"`] : [])];
  return {
    subject,
    ...layout({
      lang,
      title: subject,
      paragraphs,
      action: { label: t(`email.${type}.action`, values), url: params.url },
      footer: t("email.footer", values),
    }),
  };
};

export { EMAIL_TYPES, escapeHtml, renderEmail };
export type { EmailParams, EmailType };
