import { createTransport } from "nodemailer";
import { logger } from "../lib/logger.server";
import { renderEmail } from "../emails/templates";
import { createI18n } from "../lib/i18n";
import type { SendEmailJob } from "../models/notify.server";
import { isInstalled } from "../models/shop.server";
import { recordHealth } from "../models/health.server";

// Resend's send API is one POST, so no SDK (https://resend.com/docs/api-reference/emails/send-email).
const RESEND_URL = "https://api.resend.com/emails";

// Refused for this email itself (bad field, unverified sender, testing sender to someone other
// than the account owner): retrying won't help, so it is logged and dropped.
const isPermanent = (status: number, name: unknown) =>
  status === 400 || status === 422 || (status === 403 && name === "validation_error");

type Email = { from: string; to: string; subject: string; html: string; text: string };
type SendMail = (email: Email) => Promise<unknown>;

// SMTP (e.g. Gmail with an app password, free, ~500 emails a day) for setups without an own domain.
// SMTP_URL like smtps://user%40gmail.com:apppassword@smtp.gmail.com:465; EMAIL_FROM must be that
// mailbox. One transport per process.
let smtp: { url: string; send: SendMail } | undefined;
const smtpSender = (url: string): SendMail => {
  if (smtp?.url !== url) {
    const transport = createTransport(url);
    smtp = { url, send: (email) => transport.sendMail(email) };
  }
  return smtp.send;
};

// 550–553: mailbox unavailable, not allowed or invalid address. Retrying won't help.
const isPermanentSmtp = (error: unknown) => {
  const code = (error as { responseCode?: unknown }).responseCode;
  return typeof code === "number" && code >= 550 && code <= 553;
};

// ponytail: SMTP has no idempotency key, so a retry after a timeout can send the same email twice.
// Rare and harmless for notifications; Resend (own domain) avoids it.
const sendViaSmtp = async (job: SendEmailJob, email: Email, send: SendMail) => {
  try {
    await send(email);
  } catch (error) {
    const details = { shop: job.shop, type: job.type, code: (error as { responseCode?: unknown }).responseCode };
    if (isPermanentSmtp(error)) {
      logger.error(details, "email rejected by the SMTP server, not retried");
      return;
    }
    recordHealth("email", false);
    logger.warn(details, "email failed, will retry");
    throw error;
  }
  recordHealth("email", true);
  logger.info({ shop: job.shop, type: job.type }, "email sent");
};

// Throws on outages, rate limits and key errors → pg-boss retries (up to ~6 h apart), so a
// provider outage or a bad key only delays emails (scenario 13). The pg-boss job id is the
// idempotency key: a retry after a timeout can't send the same email twice (24 h window).
// Resend when RESEND_API_KEY is set, else SMTP when SMTP_URL is set, else skipped.
const runSendEmail = async (
  job: SendEmailJob,
  options: { jobId?: string; fetchImpl?: typeof fetch; sendMail?: SendMail } = {},
) => {
  if (!(await isInstalled(job.shop))) return;
  const apiKey = process.env.RESEND_API_KEY;
  const smtpUrl = process.env.SMTP_URL;
  const from = process.env.EMAIL_FROM;
  if ((!apiKey && !smtpUrl) || !from) {
    logger.warn({ shop: job.shop, type: job.type }, "email skipped: EMAIL_FROM and RESEND_API_KEY or SMTP_URL not set");
    return;
  }

  const i18n = createI18n(job.locale);
  const { subject, html, text } = renderEmail(job.type, job.params, i18n.t, i18n.language);
  if (!apiKey && smtpUrl) {
    return sendViaSmtp(job, { from, to: job.to, subject, html, text }, options.sendMail ?? smtpSender(smtpUrl));
  }
  if (!apiKey) return;
  const response = await (options.fetchImpl ?? fetch)(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.jobId ? { "Idempotency-Key": `send-email-${options.jobId}` } : {}),
    },
    body: JSON.stringify({ from, to: job.to, subject, html, text, tags: [{ name: "type", value: job.type }] }),
  }).catch((error: unknown) => {
    recordHealth("email", false); // network: Resend unreachable
    throw error;
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { name?: unknown; message?: unknown };
    const details = { shop: job.shop, type: job.type, status: response.status, name: body.name, message: body.message };
    if (isPermanent(response.status, body.name)) {
      logger.error(details, "email rejected by Resend, not retried");
      return;
    }
    recordHealth("email", false);
    logger.warn(details, "email failed, will retry");
    throw new Error(`Resend responded ${response.status}`);
  }
  recordHealth("email", true);
  logger.info({ shop: job.shop, type: job.type }, "email sent");
};

export { runSendEmail };
