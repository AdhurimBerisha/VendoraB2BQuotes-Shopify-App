import { expect, test } from "vitest";
import { startOfMonthInTz } from "./dates";
import { createI18n, pickLocale } from "./i18n";

test("pickLocale: unknown → en; regional variants fall back to the base language", () => {
  expect(pickLocale("xx")).toBe("en");
  expect(pickLocale(null)).toBe("en");
  expect(pickLocale("en-GB")).toBe("en");
  expect(pickLocale("en")).toBe("en");
});

test("createI18n translates synchronously, with plurals and interpolation", () => {
  const i18n = createI18n("en");
  expect(i18n.t("quote.status.PENDING_APPROVAL")).toBe("Pending approval");
  expect(i18n.t("import.summary.lines", { count: 1 })).toBe("1 line to add");
  expect(i18n.t("import.summary.lines", { count: 3 })).toBe("3 lines to add");
  expect(i18n.t("errors.invalidInput", { fields: "quantity" })).toBe("Please check these fields: quantity");
});

test("startOfMonthInTz: midnight on the 1st in the shop's zone", () => {
  // 2026-10-31 02:00 UTC is still 30 Oct in Toronto (UTC-4) → 1 Oct 00:00 Toronto = 04:00 UTC.
  expect(startOfMonthInTz(new Date("2026-10-31T02:00:00Z"), "America/Toronto").toISOString()).toBe("2026-10-01T04:00:00.000Z");
  // 2026-11-01 00:30 in Tokyo (UTC+9) is already November there.
  expect(startOfMonthInTz(new Date("2026-10-31T15:30:00Z"), "Asia/Tokyo").toISOString()).toBe("2026-10-31T15:00:00.000Z");
  expect(startOfMonthInTz(new Date("2026-10-15T12:00:00Z"), "UTC").toISOString()).toBe("2026-10-01T00:00:00.000Z");
});
