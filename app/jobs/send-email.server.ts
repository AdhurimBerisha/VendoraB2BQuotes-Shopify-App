import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
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
    const details = {
      shop: job.shop,
      type: job.type,
      code: (error as { responseCode?: unknown }).responseCode,
      // e.g. "connect ETIMEDOUT" when the host blocks SMTP ports (Render free does).
      error: error instanceof Error ? error.message : String(error),
    };
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

// Gmail API over HTTPS: free like SMTP but on port 443, which hosts that block SMTP (Render free)
// allow. GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN come from a Google Cloud OAuth
// client with the gmail.send scope (README); EMAIL_FROM must be that Gmail address.
// https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

type GmailCredentials = { clientId: string; clientSecret: string; refreshToken: string };

const gmailCredentials = (): GmailCredentials | undefined => {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : undefined;
};

// Access tokens last about an hour; one per process, renewed a minute early.
let gmailToken: { refreshToken: string; value: string; expiresAt: number } | undefined;

const gmailAccessToken = async (credentials: GmailCredentials, fetchImpl: typeof fetch) => {
  if (gmailToken?.refreshToken === credentials.refreshToken && gmailToken.expiresAt > Date.now()) {
    return gmailToken.value;
  }
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof body.access_token !== "string") {
    // invalid_grant = refresh token revoked or expired (7 days while the OAuth app is in "Testing").
    throw new Error(`Google token endpoint responded ${response.status} ${String(body.error ?? "")}`.trim());
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  gmailToken = {
    refreshToken: credentials.refreshToken,
    value: body.access_token,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  };
  return gmailToken.value;
};

// ponytail: like SMTP, no idempotency key, so a retry after a timeout can send the same email twice.
const sendViaGmail = async (job: SendEmailJob, email: Email, credentials: GmailCredentials, fetchImpl: typeof fetch) => {
  const raw = (await new MailComposer(email).compile().build()).toString("base64url");
  let response: Response;
  try {
    const accessToken = await gmailAccessToken(credentials, fetchImpl);
    response = await fetchImpl(GMAIL_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
  } catch (error) {
    recordHealth("email", false); // network or token refresh
    logger.warn({ shop: job.shop, type: job.type, error: String(error) }, "email failed, will retry");
    throw error;
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: unknown } };
    const details = { shop: job.shop, type: job.type, status: response.status, message: body.error?.message };
    // 400: this message is invalid (e.g. a bad recipient address). 401/403/429/5xx: token, quota or outage.
    if (response.status === 400) {
      logger.error(details, "email rejected by Gmail, not retried");
      return;
    }
    if (response.status === 401) gmailToken = undefined;
    recordHealth("email", false);
    logger.warn(details, "email failed, will retry");
    throw new Error(`Gmail responded ${response.status}`);
  }
  recordHealth("email", true);
  logger.info({ shop: job.shop, type: job.type }, "email sent");
};

// Throws on outages, rate limits and key errors → pg-boss retries (up to ~6 h apart), so a
// provider outage or a bad key only delays emails (scenario 13). The pg-boss job id is the
// idempotency key: a retry after a timeout can't send the same email twice (24 h window).
// Resend when RESEND_API_KEY is set, else Gmail API when the GMAIL_* trio is set, else SMTP when
// SMTP_URL is set, else skipped.
const runSendEmail = async (
  job: SendEmailJob,
  options: { jobId?: string; fetchImpl?: typeof fetch; sendMail?: SendMail } = {},
) => {
  if (!(await isInstalled(job.shop))) return;
  const apiKey = process.env.RESEND_API_KEY;
  const gmail = gmailCredentials();
  const smtpUrl = process.env.SMTP_URL;
  const from = process.env.EMAIL_FROM;
  if ((!apiKey && !gmail && !smtpUrl) || !from) {
    logger.warn(
      { shop: job.shop, type: job.type },
      "email skipped: EMAIL_FROM and RESEND_API_KEY, GMAIL_* or SMTP_URL not set",
    );
    return;
  }

  const i18n = createI18n(job.locale);
  const { subject, html, text } = renderEmail(job.type, job.params, i18n.t, i18n.language);
  if (!apiKey && gmail) {
    return sendViaGmail(job, { from, to: job.to, subject, html, text }, gmail, options.fetchImpl ?? fetch);
  }
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
