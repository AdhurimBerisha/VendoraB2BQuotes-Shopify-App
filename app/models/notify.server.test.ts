import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../db.server";
import { enqueue } from "../jobs/queue.server";
import { testQuote, testShop } from "../test/factories";
import { notify } from "./notify.server";
import { redactShop } from "./privacy.server";

vi.mock("../jobs/queue.server", () => ({ enqueue: vi.fn(async () => "job-id"), getBoss: vi.fn(async () => ({})) }));
const enqueueMock = vi.mocked(enqueue);

let SHOP: string;
let QUOTE: string;

beforeAll(async () => {
  SHOP = (await testShop({ name: "Snowdevil", notifyEmails: ["orders@shop.test"] })).id;
  QUOTE = (await testQuote(SHOP)).id;
  const member = (shopifyUserId: bigint, role: string, email: string | null, notificationPrefs = {}) => ({
    shop: SHOP,
    shopifyUserId,
    displayName: `User ${shopifyUserId}`,
    role,
    email,
    notificationPrefs,
  });
  await db.staffMember.createMany({
    data: [
      member(1n, "OWNER", "owner@shop.test"),
      member(2n, "MANAGER", "manager@shop.test"),
      member(3n, "MANAGER", "quiet@shop.test", { approvalNeeded: false }),
      member(4n, "MANAGER", null),
      member(5n, "REP", "rep@shop.test"),
    ],
  });
});

beforeEach(() => enqueueMock.mockClear());

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

const recipients = () => enqueueMock.mock.calls.map(([, job]) => (job as { to: string }).to).sort();

test("managers: one job per OWNER/MANAGER with an email, pref off and the requester excluded", async () => {
  await notify(db, SHOP, "approvalNeeded", { kind: "managers", except: 2n }, { quoteId: QUOTE, actor: "Rep" });

  expect(recipients()).toEqual(["owner@shop.test"]);
  const [name, job] = enqueueMock.mock.calls[0];
  expect(name).toBe("send-email");
  expect(job).toMatchObject({
    shop: SHOP,
    type: "approvalNeeded",
    params: { shopName: "Snowdevil", url: expect.stringContaining(`/app/quotes/${QUOTE}`) },
  });
});

test("user: only that staff member", async () => {
  await notify(db, SHOP, "approved", { kind: "user", userId: 5n }, { quoteId: QUOTE });
  expect(recipients()).toEqual(["rep@shop.test"]);
});

test("user without an id (no assigned rep): nothing queued", async () => {
  await notify(db, SHOP, "quoteViewed", { kind: "user", userId: null }, { quoteId: QUOTE });
  expect(enqueueMock).not.toHaveBeenCalled();
});

test("quoteOrdered also goes to the shop's notify list", async () => {
  await notify(db, SHOP, "quoteOrdered", { kind: "user", userId: 5n }, { quoteId: QUOTE });
  expect(recipients()).toEqual(["orders@shop.test", "rep@shop.test"]);
});

test("a quote of another shop: nothing queued", async () => {
  const other = await testShop();
  const quote = await testQuote(other.id);
  await notify(db, SHOP, "approved", { kind: "user", userId: 5n }, { quoteId: quote.id });
  expect(enqueueMock).not.toHaveBeenCalled();
  await redactShop(other.id);
});
