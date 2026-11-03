import { afterEach, expect, test, vi } from "vitest";
import { quoteLink, signQuoteToken, verifyQuoteToken } from "./signed-token.server";

const payload = { shop: "a.myshopify.com", quoteId: "q1", version: 2, exp: Date.now() + 60_000 };

afterEach(() => {
  vi.unstubAllEnvs();
});

test("sign → verify returns the same payload", () => {
  expect(verifyQuoteToken(signQuoteToken(payload))).toEqual(payload);
});

test("a changed signature character is rejected", () => {
  const token = signQuoteToken(payload);
  const last = token.at(-2) === "A" ? "B" : "A"; // not the final char: its low bits may be ignored
  const tampered = `${token.slice(0, -2)}${last}${token.slice(-1)}`;
  expect(verifyQuoteToken(tampered)).toBeNull();
});

test("a changed payload with the old signature is rejected", () => {
  const [, sig] = signQuoteToken(payload).split(".");
  const body = Buffer.from(JSON.stringify({ ...payload, quoteId: "q2" })).toString("base64url");
  expect(verifyQuoteToken(`${body}.${sig}`)).toBeNull();
});

test("an expired token is rejected", () => {
  expect(verifyQuoteToken(signQuoteToken({ ...payload, exp: Date.now() - 1 }))).toBeNull();
});

test("the old secret works during rotation, and stops after", () => {
  vi.stubEnv("APP_SIGNING_SECRET", "old-secret");
  const token = signQuoteToken(payload);
  vi.stubEnv("APP_SIGNING_SECRET", "new-secret");
  vi.stubEnv("APP_SIGNING_SECRET_OLD", "old-secret");
  expect(verifyQuoteToken(token)).toEqual(payload);
  vi.stubEnv("APP_SIGNING_SECRET_OLD", "");
  expect(verifyQuoteToken(token)).toBeNull();
});

test("garbage never throws", () => {
  for (const token of ["", ".", "a.b.c", "a.b", "%%%.***", "eyJ4IjoxfQ.", `${"x".repeat(5000)}.y`]) {
    expect(verifyQuoteToken(token)).toBeNull();
  }
});

test("a signed non-object payload is rejected", () => {
  const body = Buffer.from("42").toString("base64url");
  const [, sig] = signQuoteToken(payload).split(".");
  expect(verifyQuoteToken(`${body}.${sig}`)).toBeNull();
});

test("link expiry: quote expiry + 7 days, at most 120 days", () => {
  const now = Date.UTC(2026, 0, 1);
  const day = 86_400_000;
  const expOf = (link: string) => verifyQuoteToken(link.split("/q/")[1], now)?.exp;
  const base = { shop: "a.myshopify.com", quoteId: "q1", version: 1 };

  expect(expOf(quoteLink("https://app.test/", { ...base, expiresAt: new Date(now + 30 * day) }, now))).toBe(now + 37 * day);
  expect(expOf(quoteLink("https://app.test", { ...base, expiresAt: new Date(now + 200 * day) }, now))).toBe(now + 120 * day);
  expect(expOf(quoteLink("https://app.test", { ...base, expiresAt: null }, now))).toBe(now + 120 * day);
  expect(quoteLink("https://app.test/", { ...base, expiresAt: null }, now)).toMatch(/^https:\/\/app\.test\/q\/[^/]+$/);
});
