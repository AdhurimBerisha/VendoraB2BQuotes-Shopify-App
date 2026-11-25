import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../db.server";
import { redactShop } from "../models/privacy.server";
import { testQuote, testShop } from "../test/factories";
import { enqueue } from "./queue.server";
import { runFollowUps } from "./follow-ups.server";

vi.mock("./queue.server", () => ({ enqueue: vi.fn(async () => "job-id"), getBoss: vi.fn(async () => ({})) }));
const enqueueMock = vi.mocked(enqueue);

const REP = 9n;
let SHOP: string;
let OFF: string;

beforeAll(async () => {
  SHOP = (await testShop({ timezone: "UTC", followUpNotViewedDays: 2, followUpNotOrderedDays: 3 })).id;
  OFF = (await testShop()).id; // both settings off
  for (const shop of [SHOP, OFF]) {
    await db.staffMember.create({ data: { shop, shopifyUserId: REP, displayName: "Rep", email: "rep@shop.test" } });
  }
});

beforeEach(() => enqueueMock.mockClear());

afterAll(async () => {
  await redactShop(SHOP);
  await redactShop(OFF);
  await db.$disconnect();
});

// A SENT quote with its history written at the given times.
const sentQuote = async (shop: string, events: { action: string; at: Date }[], status = "SENT") => {
  const quote = await testQuote(shop, { overrides: { status, assignedToUserId: REP } });
  for (const event of events) {
    await db.auditEvent.create({ data: { shop, quoteId: quote.id, actorType: "SYSTEM", action: event.action, createdAt: event.at } });
  }
  return quote;
};

const emailsFor = (type: string) =>
  enqueueMock.mock.calls.filter(([queue, data]) => queue === "send-email" && (data as { type: string }).type === type);
const followUps = (quoteId: string) => db.auditEvent.count({ where: { quoteId, action: "quote.follow_up" } });

test("not opened after N days: one email, the next run sends none", async () => {
  const now = new Date("2026-12-10T12:00:00Z");
  const early = await sentQuote(SHOP, [{ action: "quote.sent", at: new Date("2026-12-09T08:00:00Z") }]); // 1 day: too soon
  const due = await sentQuote(SHOP, [{ action: "quote.sent", at: new Date("2026-12-08T23:59:00Z") }]); // 2 days

  await runFollowUps(now);
  expect(await followUps(early.id)).toBe(0);
  expect(await followUps(due.id)).toBe(1);
  expect(emailsFor("followUpNotViewed").length).toBeGreaterThanOrEqual(1);

  enqueueMock.mockClear();
  await runFollowUps(now);
  expect(await followUps(due.id)).toBe(1);
  expect(emailsFor("followUpNotViewed")).toHaveLength(0);
});

test("opened: 'not ordered' counts from the first view, and a re-send starts over", async () => {
  const quote = await sentQuote(SHOP, [
    { action: "quote.sent", at: new Date("2026-12-01T10:00:00Z") },
    { action: "quote.viewed", at: new Date("2026-12-05T10:00:00Z") },
  ]);

  await runFollowUps(new Date("2026-12-07T10:00:00Z")); // 2 days after the view: too soon
  expect(await followUps(quote.id)).toBe(0);
  await runFollowUps(new Date("2026-12-08T10:00:00Z")); // 3 days
  const first = await db.auditEvent.findFirstOrThrow({ where: { quoteId: quote.id, action: "quote.follow_up" } });
  expect(first.data).toMatchObject({ kind: "notOrdered", sentAt: "2026-12-01T10:00:00.000Z" });

  // Re-sent, not opened since: the "not opened" clock starts at the new send.
  await db.auditEvent.create({
    data: { shop: SHOP, quoteId: quote.id, actorType: "SYSTEM", action: "quote.sent", createdAt: new Date("2026-12-08T11:00:00Z") },
  });
  await runFollowUps(new Date("2026-12-10T12:00:00Z"));
  const latest = await db.auditEvent.findMany({ where: { quoteId: quote.id, action: "quote.follow_up" }, orderBy: { createdAt: "asc" } });
  expect(latest.map((event) => event.data)).toEqual([
    { kind: "notOrdered", sentAt: "2026-12-01T10:00:00.000Z" },
    { kind: "notViewed", sentAt: "2026-12-08T11:00:00.000Z" },
  ]);
});

test("settings off, other statuses and quotes never sent by Vendora: nothing", async () => {
  const sent = { action: "quote.sent", at: new Date("2026-11-01T10:00:00Z") };
  const off = await sentQuote(OFF, [sent]);
  const ordered = await sentQuote(SHOP, [sent], "ORDERED");
  const noSend = await sentQuote(SHOP, []);

  await runFollowUps(new Date("2026-12-10T12:00:00Z"));
  expect(await followUps(off.id)).toBe(0);
  expect(await followUps(ordered.id)).toBe(0);
  expect(await followUps(noSend.id)).toBe(0);
});
