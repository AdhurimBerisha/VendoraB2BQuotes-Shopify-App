import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../db.server";
import { UserError } from "../lib/errors";
import { staff, testShop } from "../test/factories";
import { graphqlError } from "../test/fake-errors";
import { advance, connectionTest, runEligibility } from "./onboarding.server";
import { redactShop } from "./privacy.server";

// M5.2: store checks, the eligibility gate and the connection test.

const COMPANY = {
  id: "gid://shopify/Company/1",
  name: "Fake Co",
  mainContact: { id: "gid://shopify/CompanyContact/1" },
  locations: { nodes: [{ id: "gid://shopify/CompanyLocation/1", name: "Main", currency: "CAD" }] },
};

// An admin client that answers by operation name; unknown operations fail the test.
const fakeAdmin = (companies: unknown[] | Error) => {
  const operations: string[] = [];
  const graphql = vi.fn(async (query: string) => {
    const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "";
    operations.push(name);
    if (name === "VendoraCompanySearch") {
      if (companies instanceof Error) throw companies;
      return Response.json({ data: { companies: { nodes: companies, pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (name === "VendoraDraftOrderCreate") {
      return Response.json({
        data: { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1", updatedAt: "" }, userErrors: [] } },
      });
    }
    if (name === "VendoraDraftOrder") return Response.json({ data: { draftOrder: { id: "gid://shopify/DraftOrder/1" } } });
    if (name === "VendoraDraftOrderDelete") {
      return Response.json({ data: { draftOrderDelete: { deletedId: "gid://shopify/DraftOrder/1", userErrors: [] } } });
    }
    throw new Error(`unexpected operation ${name}`);
  });
  return { admin: { graphql } as unknown as AdminApiContext, operations };
};

const failing = async (companies: unknown[] | Error, scopes: string) =>
  (await runEligibility(fakeAdmin(companies).admin, scopes)).filter((check) => !check.ok).map((check) => check.key);

let scopesBefore: string | undefined;
beforeAll(() => {
  scopesBefore = process.env.SCOPES;
  process.env.SCOPES = "read_products,read_customers,write_draft_orders";
});
afterAll(() => {
  process.env.SCOPES = scopesBefore;
});
const GRANTED = "read_products,read_customers,write_draft_orders";

test("a store with a company, a main contact and every scope passes", async () => {
  expect(await failing([COMPANY], GRANTED)).toEqual([]);
});

test("no companies: the company and main contact checks fail", async () => {
  expect(await failing([], GRANTED)).toEqual(["company", "mainContact"]);
});

test("a company without a main contact fails only that check", async () => {
  expect(await failing([{ ...COMPANY, mainContact: null }], GRANTED)).toEqual(["mainContact"]);
});

test("ACCESS_DENIED on companies means the store has no B2B", async () => {
  expect(await failing(graphqlError("ACCESS_DENIED"), GRANTED)).toEqual(["b2b"]);
});

test("a missing scope fails the scopes check; write_x covers read_x", async () => {
  expect(await failing([COMPANY], "read_products,write_draft_orders")).toEqual(["scopes"]);
  expect(await failing([COMPANY], "write_products,read_customers,write_draft_orders")).toEqual([]);
});

test("advance refuses to leave ELIGIBILITY while a check fails, and moves on once it passes", async () => {
  const shop = await testShop({ onboardingStep: "ELIGIBILITY" });
  try {
    const refused = advance(staff(shop.id, fakeAdmin([]).admin), "ELIGIBILITY", GRANTED);
    await expect(refused).rejects.toBeInstanceOf(UserError);
    expect((await db.shop.findUniqueOrThrow({ where: { id: shop.id } })).onboardingStep).toBe("ELIGIBILITY");

    await advance(staff(shop.id, fakeAdmin([COMPANY]).admin), "ELIGIBILITY", GRANTED);
    expect((await db.shop.findUniqueOrThrow({ where: { id: shop.id } })).onboardingStep).toBe("SETTINGS");

    // A second click on the old step's button changes nothing.
    await advance(staff(shop.id, fakeAdmin([COMPANY]).admin), "ELIGIBILITY", GRANTED);
    expect((await db.shop.findUniqueOrThrow({ where: { id: shop.id } })).onboardingStep).toBe("SETTINGS");
  } finally {
    await redactShop(shop.id);
  }
});

test("the connection test creates, reads and deletes a draft order", async () => {
  const { admin, operations } = fakeAdmin([COMPANY]);
  expect(await connectionTest(staff("any.myshopify.com", admin))).toEqual({ passed: true });
  expect(operations).toEqual([
    "VendoraCompanySearch",
    "VendoraDraftOrderCreate",
    "VendoraDraftOrder",
    "VendoraDraftOrderDelete",
  ]);
});
