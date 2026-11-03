import { renderEmail } from "../emails/templates";
import { createI18n } from "../lib/i18n";
import type { SendEmailJob } from "../models/notify.server";
import { isInstalled } from "../models/shop.server";

// Resend's send API is one POST, so no SDK (https://resend.com/docs/api-reference/emails/send-email).
const RESEND_URL = "https://api.resend.com/emails";

// Refused for this email itself (bad field, unverified sender, testing sender to someone other
// than the account owner): retrying won't help, so it is logged and dropped.
const isPermanent = (status: number, name: unknown) =>
  status === 400 || status === 422 || (status === 403 && name === "validation_error");

// Throws on outages, rate limits and key errors → pg-boss retries (up to ~6 h apart), so a
// provider outage or a bad key only delays emails (scenario 13). The pg-boss job id is the
// idempotency key: a retry after a timeout can't send the same email twice (24 h window).
const runSendEmail = async (
  job: SendEmailJob,
  options: { jobId?: string; fetchImpl?: typeof fetch } = {},
) => {
  if (!(await isInstalled(job.shop))) return;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    console.warn("email skipped: RESEND_API_KEY or EMAIL_FROM not set", { shop: job.shop, type: job.type });
    return;
  }

  const i18n = createI18n(job.locale);
  const { subject, html, text } = renderEmail(job.type, job.params, i18n.t, i18n.language);
  const response = await (options.fetchImpl ?? fetch)(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.jobId ? { "Idempotency-Key": `send-email-${options.jobId}` } : {}),
    },
    body: JSON.stringify({ from, to: job.to, subject, html, text, tags: [{ name: "type", value: job.type }] }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { name?: unknown; message?: unknown };
    const details = { shop: job.shop, type: job.type, status: response.status, name: body.name, message: body.message };
    if (isPermanent(response.status, body.name)) {
      console.error("email rejected by Resend, not retried", details);
      return;
    }
    console.warn("email failed, will retry", details);
    throw new Error(`Resend responded ${response.status}`);
  }
  console.log("email sent", { shop: job.shop, type: job.type });
};

export { runSendEmail };
