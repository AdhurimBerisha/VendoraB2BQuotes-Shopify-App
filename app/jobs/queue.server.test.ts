import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import db from "../db.server";
import { redactShop } from "../models/privacy.server";
import { requestConversion } from "../models/quote.server";
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

test("requestConversion twice: quote QUEUED once, exactly one job", async () => {
  const quote = await db.quote.create({
    data: {
      shop: SHOP,
      companyId: "gid://shopify/Company/1",
      companyLocationId: "gid://shopify/CompanyLocation/1",
      companyContactId: "gid://shopify/CompanyContact/1",
      lines: [],
    },
  });

  expect((await requestConversion(SHOP, quote.id)).status).toBe("QUEUED");
  expect((await requestConversion(SHOP, quote.id)).status).toBe("QUEUED");

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
