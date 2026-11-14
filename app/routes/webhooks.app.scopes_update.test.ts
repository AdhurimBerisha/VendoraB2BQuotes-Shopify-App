import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import db from "../db.server";
import { webhookRequest } from "../test/webhook";
import { action } from "./webhooks.app.scopes_update";

// M5.3: after the merchant approves new permissions, every session of the shop knows them.
const SHOP = `vitest-${randomUUID()}.myshopify.com`;
const OTHER = `vitest-${randomUUID()}.myshopify.com`;

afterAll(async () => {
  await db.session.deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  await db.$disconnect();
});

test("app/scopes_update saves the new scopes on the shop's offline and staff sessions only", async () => {
  const session = (shop: string, isOnline: boolean) => ({
    id: randomUUID(),
    shop,
    state: "",
    isOnline,
    scope: "read_products",
    accessToken: "test-token",
  });
  await db.session.createMany({ data: [session(SHOP, false), session(SHOP, true), session(OTHER, false)] });

  const response = await action({
    request: webhookRequest("/webhooks/app/scopes_update", "app/scopes_update", SHOP, {
      previous: ["read_products"],
      current: ["read_products", "write_draft_orders"],
    }),
    params: {},
    context: {},
  } as Parameters<typeof action>[0]);

  expect(response.status).toBe(200);
  const scopes = async (shop: string) => (await db.session.findMany({ where: { shop } })).map((row) => row.scope);
  expect(await scopes(SHOP)).toEqual(["read_products,write_draft_orders", "read_products,write_draft_orders"]);
  expect(await scopes(OTHER)).toEqual(["read_products"]);
});
