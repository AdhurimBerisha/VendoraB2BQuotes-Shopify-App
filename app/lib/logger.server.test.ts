import pino from "pino";
import { expect, test } from "vitest";
import { loggerOptions } from "./logger.server";

test("secrets and customer data are redacted, errors keep their message", () => {
  const lines: string[] = [];
  const log = pino({ ...loggerOptions, level: "info" }, { write: (line: string) => lines.push(line) });

  log.info({ accessToken: "shpat_x", customer: { email: "a@b.c" }, contact: { email: "a@b.c" }, shop: "s.myshopify.com" }, "hello");
  log.error({ error: new Error("boom") }, "failed");

  expect(lines[0]).not.toContain("shpat_x");
  expect(lines[0]).not.toContain("a@b.c");
  const first = JSON.parse(lines[0]);
  expect(first).toMatchObject({ accessToken: "[redacted]", customer: "[redacted]", shop: "s.myshopify.com", msg: "hello" });
  expect(JSON.parse(lines[1]).error.message).toBe("boom");
});
