import { expect, test } from "vitest";
import { addDaysEndOfDay, endOfLocalDay, localDateString, localDaysBetween, startOfMonthInTz } from "./dates";

const FROM = new Date("2026-10-26T20:00:00Z");

test("Tokyo, +30 days: end of the local day", () => {
  // local 2026-10-27 05:00 → 2026-11-26 23:59:59.999 JST
  expect(addDaysEndOfDay(FROM, 30, "Asia/Tokyo").toISOString()).toBe("2026-11-26T14:59:59.999Z");
});

test("New York across the DST end (1 Nov): the expiry uses EST", () => {
  // local 2026-10-26 16:00 EDT → 2026-11-25 23:59:59.999 EST
  expect(addDaysEndOfDay(FROM, 30, "America/New_York").toISOString()).toBe("2026-11-26T04:59:59.999Z");
});

test("UTC, +0 days", () => {
  expect(addDaysEndOfDay(FROM, 0, "UTC").toISOString()).toBe("2026-10-26T23:59:59.999Z");
});

test("a quote expiring 'today' is a different instant in Tokyo and New York", () => {
  const now = new Date("2026-10-26T20:00:00Z"); // 27 Oct in Tokyo, 26 Oct in New York
  expect(addDaysEndOfDay(now, 0, "Asia/Tokyo").toISOString()).toBe("2026-10-27T14:59:59.999Z");
  expect(addDaysEndOfDay(now, 0, "America/New_York").toISOString()).toBe("2026-10-27T03:59:59.999Z");
});

test("start of month, Berlin", () => {
  expect(startOfMonthInTz(FROM, "Europe/Berlin").toISOString()).toBe("2026-09-30T22:00:00.000Z");
});

test("localDateString: the shop-local date", () => {
  expect(localDateString(new Date("2026-10-26T23:30:00Z"), "Asia/Tokyo")).toBe("2026-10-27");
});

test("endOfLocalDay: real dates only", () => {
  expect(endOfLocalDay("2026-11-25", "America/New_York")?.toISOString()).toBe("2026-11-26T04:59:59.999Z");
  expect(endOfLocalDay("2026-02-30", "UTC")).toBeNull();
  expect(endOfLocalDay("26-11-2026", "UTC")).toBeNull();
});

test("localDaysBetween: shop-local calendar days (M10.3)", () => {
  // 2026-11-24 23:50 and 2026-11-25 00:10 in New York (EST, UTC−5).
  const monLate = new Date("2026-11-25T04:50:00Z");
  const tueEarly = new Date("2026-11-25T05:10:00Z");
  expect(localDaysBetween(monLate, tueEarly, "America/New_York")).toBe(1);
  expect(localDaysBetween(monLate, tueEarly, "UTC")).toBe(0); // both 25 Nov in UTC
  expect(localDaysBetween(monLate, new Date("2026-12-02T04:00:00Z"), "America/New_York")).toBe(7);
});
