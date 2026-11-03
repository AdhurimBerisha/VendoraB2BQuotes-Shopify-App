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
