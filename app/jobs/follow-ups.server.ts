import { logger } from "../lib/logger.server";
import db from "../db.server";
import { localDateString, localDaysBetween } from "../lib/dates";
import { audit } from "../models/audit.server";
import { notify } from "../models/notify.server";

type FollowUpKind = "notViewed" | "notOrdered";

const EMAIL = { notViewed: "followUpNotViewed", notOrdered: "followUpNotOrdered" } as const;

// Hourly (M10.3): tell the rep about SENT quotes that go nowhere. Not opened N shop-local days
// after the last send, or opened but not ordered N days after the first view since then.
// Once per kind per send: a re-send starts the clock again.
// ponytail: a few queries per SENT quote; one grouped query when a shop has thousands of SENT quotes.
const runFollowUps = async (now = new Date()) => {
  const shops = await db.shop.findMany({
    where: { uninstalledAt: null, OR: [{ followUpNotViewedDays: { not: null } }, { followUpNotOrderedDays: { not: null } }] },
    select: { id: true, timezone: true, followUpNotViewedDays: true, followUpNotOrderedDays: true },
  });
  let sent = 0;

  for (const shop of shops) {
    const quotes = await db.quote.findMany({
      where: { shop: shop.id, status: "SENT" },
      select: { id: true, assignedToUserId: true },
    });
    for (const quote of quotes) {
      const events = await db.auditEvent.findMany({
        where: { shop: shop.id, quoteId: quote.id, action: { in: ["quote.sent", "quote.viewed", "quote.follow_up"] } },
        orderBy: { createdAt: "asc" },
        select: { action: true, createdAt: true, data: true },
      });
      const lastSent = events.filter((event) => event.action === "quote.sent").at(-1);
      if (!lastSent) continue; // e.g. SENT by a webhook before Vendora sent it
      const sentAt = lastSent.createdAt.toISOString();
      const firstView = events.find((event) => event.action === "quote.viewed" && event.createdAt >= lastSent.createdAt);
      const done = (kind: FollowUpKind) =>
        events.some((event) => {
          const data = event.data as { kind?: unknown; sentAt?: unknown } | null;
          return event.action === "quote.follow_up" && data?.kind === kind && data.sentAt === sentAt;
        });

      const due: { kind: FollowUpKind; from: Date } | null =
        !firstView && shop.followUpNotViewedDays !== null
          ? { kind: "notViewed", from: lastSent.createdAt }
          : firstView && shop.followUpNotOrderedDays !== null
            ? { kind: "notOrdered", from: firstView.createdAt }
            : null;
      if (!due || done(due.kind)) continue;
      const days = due.kind === "notViewed" ? shop.followUpNotViewedDays : shop.followUpNotOrderedDays;
      if (days === null || localDaysBetween(due.from, now, shop.timezone) < days) continue;

      const date = localDateString(due.from, shop.timezone);
      await db.$transaction(async (tx) => {
        await audit(tx, { type: "SYSTEM", shop: shop.id, reason: "follow-up" }, quote.id, "quote.follow_up", { kind: due.kind, sentAt });
        await notify(tx, shop.id, EMAIL[due.kind], { kind: "user", userId: quote.assignedToUserId }, { quoteId: quote.id, date });
      });
      sent++;
    }
  }

  logger.info({ shops: shops.length, sent }, "follow-ups done");
};

export { runFollowUps };
