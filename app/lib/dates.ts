// Dates in the shop's time zone. M2.9 adds end-of-day expiry on top of these.

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

// Midnight on the 1st of the current month in `timeZone`, as an instant.
const startOfMonthInTz = (now: Date, timeZone: string): Date => {
  const p = zonedParts(now, timeZone);
  const midnightAsUtc = Date.UTC(p.year, p.month - 1, 1);
  return new Date(midnightAsUtc - zoneOffsetMs(new Date(midnightAsUtc), timeZone));
};

const formatDateTime = (date: Date, locale: string, timeZone: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);

const formatDate = (date: Date, locale: string, timeZone: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(date);

export { formatDate, formatDateTime, startOfMonthInTz };
