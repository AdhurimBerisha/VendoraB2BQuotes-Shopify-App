import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import db from "../db.server";
import { redactShop } from "../models/privacy.server";
import { ConflictError } from "../lib/errors";
import { requestSync } from "../models/sync.server";
import { testQuote } from "../test/factories";
import { enqueue, getBoss } from "./queue.server";

// Real pg-boss on the test database: proves jobs and state changes commit together.
const SHOP = `vitest-${randomUUID()}.myshopify.com`;

afterAll(async () => {
  await redactShop(SHOP);
  await (await getBoss()).stop({ graceful: false });
  globalThis.vendoraBoss = undefined;
  await db.$disconnect();
});

const jobsWith = async (key: string, value: string) => {
  const rows = await db.$queryRaw<{ count: bigint }[]>`
    select count(*) from pgboss.job where data->>${key} = ${value}`;
  return Number(rows[0].count);
};

test("requestSync twice: quote QUEUED once, exactly one job", async () => {
  const quote = await testQuote(SHOP);
  const actor = { type: "SYSTEM" as const, shop: SHOP, reason: "test" };

  await requestSync(actor, quote.id);
  await expect(requestSync(actor, quote.id)).rejects.toBeInstanceOf(ConflictError);

  const saved = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
  expect(saved.syncStatus).toBe("QUEUED");
  expect(await jobsWith("quoteId", quote.id)).toBe(1);
});

test("a job sent inside a rolled-back transaction does not exist", async () => {
  const marker = randomUUID();
  await getBoss();

  await expect(
    db.$transaction(async (tx) => {
      await enqueue("privacy", { marker }, { tx });
      throw new Error("roll back");
    }),
  ).rejects.toThrow("roll back");

  expect(await jobsWith("marker", marker)).toBe(0);
});
