import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../db.server";
import { getBoss } from "../jobs/queue.server";
import { NotFoundError } from "../lib/errors";
import { fakeShopify } from "../test/fake-shopify";
import { staff, testShop } from "../test/factories";
import { listFailedJobs, retryFailedJob } from "./jobs.server";
import { redactShop } from "./privacy.server";

let SHOP_A: string;
let SHOP_B: string;
const created: { name: string; id: string }[] = [];

// A job as pg-boss leaves it after the last retry: in "<queue>-dead".
const deadJob = async (shop: string, quoteId = "quote-x") => {
  const boss = await getBoss();
  const id = await boss.send("send-invoice-dead", { shop, quoteId, versionId: "v", message: "" });
  if (!id) throw new Error("no job");
  created.push({ name: "send-invoice-dead", id });
  return id;
};

beforeAll(async () => {
  SHOP_A = (await testShop()).id;
  SHOP_B = (await testShop()).id;
});

afterAll(async () => {
  const boss = await getBoss();
  for (const { name, id } of created) await boss.deleteJob(name, id).catch(() => undefined);
  const redriven = await boss.findJobs("send-invoice", { data: { quoteId: "quote-x" } });
  for (const job of redriven) await boss.deleteJob("send-invoice", job.id).catch(() => undefined);
  await redactShop(SHOP_A);
  await redactShop(SHOP_B);
  await db.$disconnect();
});

test("the Jobs page of shop A never shows or retries shop B's jobs", async () => {
  const mine = await deadJob(SHOP_A);
  const theirs = await deadJob(SHOP_B);
  const managerA = staff(SHOP_A, fakeShopify().admin, "MANAGER");

  const jobs = await listFailedJobs(managerA);
  expect(jobs.map((job) => job.id)).toEqual([mine]);
  expect(jobs[0]).toMatchObject({ queue: "send-invoice", quoteId: "quote-x" });

  await expect(retryFailedJob(managerA, "send-invoice", theirs)).rejects.toThrow(NotFoundError);
  await expect(retryFailedJob(managerA, "expire-quotes", mine)).rejects.toThrow("errors.invalidInput");
});

test("retry moves the dead job back to its queue and records who did it", async () => {
  const id = await deadJob(SHOP_A);
  const owner = staff(SHOP_A, fakeShopify().admin, "OWNER");

  await retryFailedJob(owner, "send-invoice", id);

  expect((await listFailedJobs(owner)).map((job) => job.id)).not.toContain(id);
  const boss = await getBoss();
  const back = await boss.findJobs("send-invoice", { data: { shop: SHOP_A }, queued: true });
  expect(back).toHaveLength(1);
  expect(await db.auditEvent.count({ where: { shop: SHOP_A, action: "job.retried" } })).toBe(1);
});

test("a rep can't see the Jobs page", async () => {
  await expect(listFailedJobs(staff(SHOP_A, fakeShopify().admin, "REP"))).rejects.toThrow("errors.forbidden");
});
