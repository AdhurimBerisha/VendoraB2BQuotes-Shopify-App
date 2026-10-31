// Dates in the shop's time zone, with Intl only (no library). Quotes expire at the end of a
// shop-local day (G-13).

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const zonedParts = (date: Date, timeZone: string): ZonedParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
};

// How far the zone's wall clock is ahead of UTC at this instant (ms).
const zoneOffsetMs = (date: Date, timeZone: string) => {
  const p = zonedParts(date, timeZone);
  const wallClock = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallClock - Math.floor(date.getTime() / 1000) * 1000;
};

// A wall-clock time in `timeZone` → the real instant. The second offset check handles days
// where the offset changes (DST).
const zonedToUtc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date => {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const firstOffset = zoneOffsetMs(new Date(guess), timeZone);
  let utc = guess - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(utc), timeZone);
  if (secondOffset !== firstOffset) utc = guess - secondOffset;
  return new Date(utc);
};

// 23:59:59.999 on the shop-local day that is `days` after `from`'s shop-local date.
const addDaysEndOfDay = (from: Date, days: number, timeZone: string): Date => {
  const p = zonedParts(from, timeZone);
  const local = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedToUtc(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), 23, 59, 59, 999, timeZone);
};

// 23:59:59.999 on a shop-local "YYYY-MM-DD" (date inputs); null if it isn't a real date.
const endOfLocalDay = (localDate: string, timeZone: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null; // e.g. 2026-02-30
  return zonedToUtc(year, month, day, 23, 59, 59, 999, timeZone);
};

// Midnight on the 1st of the current month in `timeZone`.
const startOfMonthInTz = (now: Date, timeZone: string): Date => {
  const p = zonedParts(now, timeZone);
  return zonedToUtc(p.year, p.month, 1, 0, 0, 0, 0, timeZone);
};

// "2026-11-26": the shop-local date, for date inputs.
const localDateString = (date: Date, timeZone: string) => {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

const formatDateTime = (date: Date, locale: string, timeZone: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);

const formatDate = (date: Date, locale: string, timeZone: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(date);

export {
  addDaysEndOfDay,
  endOfLocalDay,
  formatDate,
  formatDateTime,
  localDateString,
  startOfMonthInTz,
  zonedToUtc,
};
