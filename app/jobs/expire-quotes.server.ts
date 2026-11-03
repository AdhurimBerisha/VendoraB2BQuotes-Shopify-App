import db from "../db.server";
import { audit } from "../models/audit.server";
import { notify } from "../models/notify.server";
import { expireQuote } from "../models/quote.server";
import { localDateString } from "../lib/dates";

const OPEN = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT"];
const BATCH = 200;
const REMIND_MS = 3 * 86_400_000;

const installedShops = async () =>
  (await db.shop.findMany({ where: { uninstalledAt: null }, select: { id: true } })).map((shop) => shop.id);

// Hourly (pg-boss schedule): expire past-due quotes in every installed shop, then remind once
// per expiry date about quotes expiring within 3 days.
const runExpireQuotes = async (now = new Date()) => {
  const shops = await installedShops();
  let expired = 0;
  let failed = 0;

  // 1. Expire. Walks forward by id, so a quote that keeps failing can't stall the batch;
  // it is tried again next hour.
  let lastId: string | undefined;
  for (;;) {
    const due = await db.quote.findMany({
      where: { status: { in: OPEN }, expiresAt: { lt: now }, shop: { in: shops }, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: { id: true, shop: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    for (const quote of due) {
      try {
        if (await expireQuote(quote.shop, quote.id, now)) expired++;
      } catch (error) {
        failed++;
        console.error("quote not expired, retried next hour", { shop: quote.shop, quoteId: quote.id, error });
      }
    }
    if (due.length < BATCH) break;
    lastId = due[due.length - 1].id;
  }

  // 2. Reminders, once per quote and expiry date (a new date gets a new reminder).
  const soon = await db.quote.findMany({
    where: {
      status: { in: ["APPROVED", "SENT"] },
      expiresAt: { gte: now, lt: new Date(now.getTime() + REMIND_MS) },
      shop: { in: shops },
    },
    select: { id: true, shop: true, expiresAt: true, assignedToUserId: true },
  });
  const timezones = new Map(
    (await db.shop.findMany({ where: { id: { in: [...new Set(soon.map((quote) => quote.shop))] } }, select: { id: true, timezone: true } }))
      .map((shop) => [shop.id, shop.timezone]),
  );
  let reminded = 0;
  for (const quote of soon) {
    const expiresAt = quote.expiresAt?.toISOString() ?? "";
    const already = await db.auditEvent.findFirst({
      where: { shop: quote.shop, quoteId: quote.id, action: "quote.expiry_reminded", data: { path: ["expiresAt"], equals: expiresAt } },
    });
    if (already) continue;
    const date = quote.expiresAt ? localDateString(quote.expiresAt, timezones.get(quote.shop) ?? "UTC") : "";
    await db.$transaction(async (tx) => {
      await audit(tx, { type: "SYSTEM", shop: quote.shop, reason: "expiry" }, quote.id, "quote.expiry_reminded", { expiresAt });
      await notify(tx, quote.shop, "expiringSoon", { kind: "user", userId: quote.assignedToUserId }, { quoteId: quote.id, date });
    });
    reminded++;
  }

  console.log("expire-quotes done", { shops: shops.length, expired, failed, reminded });
};

export { runExpireQuotes };
