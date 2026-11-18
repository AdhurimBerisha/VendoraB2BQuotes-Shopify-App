import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import db from "../db.server";
import type { SendEmailJob } from "../models/notify.server";
import { redactShop } from "../models/privacy.server";
import { testShop } from "../test/factories";
import { runSendEmail } from "./send-email.server";

let SHOP: string;

beforeAll(async () => {
  SHOP = (await testShop()).id;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

const job = (): SendEmailJob => ({
  shop: SHOP,
  type: "approved",
  to: "rep@shop.test",
  locale: "en",
  params: { quoteLabel: "Q-1001", shopName: "Snowdevil", url: "https://a.test", actor: "Ana" },
});

const withResend = () => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "Vendora <onboarding@resend.dev>");
};

const fails = (status: number, name: string) =>
  vi.fn(async () => Response.json({ statusCode: status, name, message: "x" }, { status }));

test("sends one Resend request with the rendered email and the job id as idempotency key", async () => {
  withResend();
  const fetchMock = vi.fn(async () => Response.json({ id: "email-1" }));

  await runSendEmail(job(), { jobId: "job-1", fetchImpl: fetchMock as unknown as typeof fetch });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.resend.com/emails");
  expect(init.headers).toMatchObject({ Authorization: "Bearer re_test", "Idempotency-Key": "send-email-job-1" });
  expect(JSON.parse(String(init.body))).toMatchObject({
    from: "Vendora <onboarding@resend.dev>",
    to: "rep@shop.test",
    subject: "Approved: Q-1001",
    tags: [{ name: "type", value: "approved" }],
  });
});

test("outage, rate limit or bad key: the job throws so pg-boss retries (scenario 13)", async () => {
  withResend();
  for (const [status, name] of [
    [401, "validation_error"],
    [403, "suspended_api_key"],
    [429, "rate_limit_exceeded"],
    [500, "application_error"],
    [503, "service_unavailable"],
  ] as const) {
    const fetchImpl = fails(status, name) as unknown as typeof fetch;
    await expect(runSendEmail(job(), { fetchImpl })).rejects.toThrow(String(status));
  }
});

test("refused for this email (bad field, testing sender to someone else): dropped, not retried", async () => {
  withResend();
  for (const [status, name] of [
    [400, "validation_error"],
    [403, "validation_error"],
    [422, "missing_required_field"],
  ] as const) {
    const fetchImpl = fails(status, name) as unknown as typeof fetch;
    await expect(runSendEmail(job(), { fetchImpl })).resolves.toBeUndefined();
  }
});

test("no API key: skipped with a warning", async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("SMTP_URL", "");
  vi.stubEnv("GMAIL_REFRESH_TOKEN", "");
  const fetchMock = vi.fn();
  await runSendEmail(job(), { fetchImpl: fetchMock as unknown as typeof fetch });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("uninstalled shop: skipped", async () => {
  withResend();
  const shop = await testShop({ uninstalledAt: new Date() });
  const fetchMock = vi.fn();
  await runSendEmail({ ...job(), shop: shop.id }, { fetchImpl: fetchMock as unknown as typeof fetch });
  expect(fetchMock).not.toHaveBeenCalled();
  await redactShop(shop.id);
});

const withSmtp = () => {
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("GMAIL_REFRESH_TOKEN", "");
  vi.stubEnv("SMTP_URL", "smtps://me%40gmail.test:pw@smtp.gmail.test:465");
  vi.stubEnv("EMAIL_FROM", "Vendora <me@gmail.test>");
};

const smtpError = (responseCode: number) => Object.assign(new Error(`SMTP ${responseCode}`), { responseCode });

test("SMTP: without a Resend key the rendered email goes through SMTP", async () => {
  withSmtp();
  const sendMail = vi.fn(async () => ({ messageId: "m-1" }));
  const fetchMock = vi.fn();

  await runSendEmail(job(), { sendMail, fetchImpl: fetchMock as unknown as typeof fetch });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(sendMail.mock.calls[0]).toEqual([
    expect.objectContaining({ from: "Vendora <me@gmail.test>", to: "rep@shop.test", subject: "Approved: Q-1001" }),
  ]);
});

test("SMTP: a refused address is dropped, an outage or bad password is retried", async () => {
  withSmtp();
  for (const code of [550, 553]) {
    const sendMail = vi.fn(async () => Promise.reject(smtpError(code)));
    await expect(runSendEmail(job(), { sendMail })).resolves.toBeUndefined();
  }
  for (const code of [421, 454, 535]) {
    const sendMail = vi.fn(async () => Promise.reject(smtpError(code)));
    await expect(runSendEmail(job(), { sendMail })).rejects.toThrow(`SMTP ${code}`);
  }
});

// Each test gets its own refresh token so the per-process access-token cache doesn't leak between them.
let gmailRun = 0;
const withGmail = () => {
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("GMAIL_CLIENT_ID", "cid");
  vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
  vi.stubEnv("GMAIL_REFRESH_TOKEN", `rt-${(gmailRun += 1)}`);
  vi.stubEnv("EMAIL_FROM", "Vendora <me@gmail.test>");
};

const gmailFetch = (send: Response) =>
  vi.fn(async (url: string) =>
    url === "https://oauth2.googleapis.com/token"
      ? Response.json({ access_token: "at-1", expires_in: 3599 })
      : send.clone(),
  );

test("Gmail: without a Resend key the email is sent as a raw MIME message through the Gmail API", async () => {
  withGmail();
  const fetchMock = gmailFetch(Response.json({ id: "g-1" }));
  const sendMail = vi.fn();

  await runSendEmail(job(), { fetchImpl: fetchMock as unknown as typeof fetch, sendMail });

  expect(sendMail).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
  expect(String(tokenInit.body)).toContain("grant_type=refresh_token");
  const [sendUrl, sendInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
  expect(sendUrl).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  expect(sendInit.headers).toMatchObject({ Authorization: "Bearer at-1" });
  const raw = Buffer.from(JSON.parse(String(sendInit.body)).raw, "base64url").toString();
  expect(raw).toContain("To: rep@shop.test");
  expect(raw).toContain("Subject: Approved: Q-1001");

  // Second email in the same process reuses the access token.
  await runSendEmail(job(), { fetchImpl: fetchMock as unknown as typeof fetch });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("Gmail: an invalid message is dropped; token, quota and outage errors are retried", async () => {
  withGmail();
  const bad = gmailFetch(Response.json({ error: { message: "Invalid To header" } }, { status: 400 }));
  await expect(runSendEmail(job(), { fetchImpl: bad as unknown as typeof fetch })).resolves.toBeUndefined();

  for (const status of [401, 403, 429, 500]) {
    withGmail();
    const failing = gmailFetch(Response.json({ error: { message: "x" } }, { status }));
    await expect(runSendEmail(job(), { fetchImpl: failing as unknown as typeof fetch })).rejects.toThrow(
      `Gmail responded ${status}`,
    );
  }

  withGmail();
  const revoked = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await expect(runSendEmail(job(), { fetchImpl: revoked as unknown as typeof fetch })).rejects.toThrow("invalid_grant");
});
