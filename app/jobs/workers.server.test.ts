import type { Job } from "pg-boss";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../db.server";
import type { AttentionItem } from "../models/attention";
import { isDegraded, recordHealth, resetHealth } from "../models/health.server";
import { redactShop } from "../models/privacy.server";
import type { SyncJob } from "../models/sync.server";
import { testQuote, testShop } from "../test/factories";
import { enqueue } from "./queue.server";
import { handle } from "./workers.server";

vi.mock("./queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.server")>()),
  enqueue: vi.fn(async () => "job-id"),
  getBoss: vi.fn(async () => ({})),
}));
const enqueueMock = vi.mocked(enqueue);

let SHOP: string;

beforeAll(async () => {
  SHOP = (await testShop()).id;
  await db.staffMember.create({
    data: { shop: SHOP, shopifyUserId: 2n, displayName: "Manager", role: "MANAGER", email: "manager@example.com" },
  });
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

const job = (data: SyncJob, retryCount: number) => ({ id: "job-1", data, retryCount }) as unknown as Job<SyncJob>;
const codes = (attention: unknown) => ((attention as AttentionItem[] | null) ?? []).map((item) => item.code);

test("sync job fails before the last attempt: rethrown, quote untouched", async () => {
  const quote = await testQuote(SHOP, { overrides: { syncStatus: "SYNCING" } });
  const run = handle<SyncJob>("sync-draft-order", async () => {
    throw new Error("socket hang up");
  });

  await expect(run([job({ shop: SHOP, quoteId: quote.id, op: "upsert" }, 2)])).rejects.toThrow("socket hang up");

  expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).syncStatus).toBe("SYNCING");
});

test("sync job fails its last attempt: NEEDS_ATTENTION + RETRIES_EXHAUSTED, managers emailed", async () => {
  enqueueMock.mockClear();
  const quote = await testQuote(SHOP, { overrides: { syncStatus: "SYNCING" } });
  const run = handle<SyncJob>("sync-draft-order", async () => {
    throw new Error("socket hang up");
  });

  await expect(run([job({ shop: SHOP, quoteId: quote.id, op: "upsert" }, 6)])).rejects.toThrow("socket hang up");

  const saved = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
  expect(saved.syncStatus).toBe("NEEDS_ATTENTION");
  expect(saved.syncClaimedAt).toBeNull();
  expect(codes(saved.attention)).toEqual(["RETRIES_EXHAUSTED"]);
  const emails = enqueueMock.mock.calls.filter(([name, data]) => name === "send-email" && (data as { type: string }).type === "needsAttention");
  expect(emails).toHaveLength(1);
});

test("degraded: 10 failures and no success in 5 minutes; one success clears it", () => {
  resetHealth();
  const now = Date.now();
  for (let i = 0; i < 9; i++) recordHealth("shopify", false, now);
  expect(isDegraded("shopify", now)).toBe(false);
  recordHealth("shopify", false, now);
  expect(isDegraded("shopify", now)).toBe(true);
  expect(isDegraded("email", now)).toBe(false);
  recordHealth("shopify", true, now);
  expect(isDegraded("shopify", now)).toBe(false);
  // Old failures fall out of the window.
  resetHealth();
  for (let i = 0; i < 10; i++) recordHealth("shopify", false, now - 6 * 60_000);
  expect(isDegraded("shopify", now)).toBe(false);
});
