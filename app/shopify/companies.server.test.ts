import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { expect, test, vi } from "vitest";
import { companyNames } from "./companies.server";

// M4.6: company names are cached per shop for 5 minutes.
const company = (n: number) => `gid://shopify/Company/${n}`;
const DELETED = company(9);

const fakeAdmin = () => {
  const graphql = vi.fn(async (_query: string, options: { variables: { ids: string[] } }) =>
    Response.json({
      data: { nodes: options.variables.ids.map((id) => (id === DELETED ? null : { id, name: `Name ${id.split("/").pop()}` })) },
    }),
  );
  return { admin: { graphql } as unknown as AdminApiContext, asked: () => graphql.mock.calls.map(([, options]) => options.variables.ids) };
};

test("names come from Shopify once, then from the cache for 5 minutes, per shop", async () => {
  const { admin, asked } = fakeAdmin();
  const now = Date.now();

  const first = await companyNames(admin, "a.myshopify.com", [company(1), company(2), DELETED], now);
  expect([...first]).toEqual([
    [company(1), "Name 1"],
    [company(2), "Name 2"],
  ]);

  // Cached ones (the deleted company too) aren't asked again; only the new one is.
  const second = await companyNames(admin, "a.myshopify.com", [company(1), DELETED, company(3)], now + 60_000);
  expect(second.get(company(1))).toBe("Name 1");
  expect(second.has(DELETED)).toBe(false);

  // Another shop never reads shop A's entries; after 5 minutes they're asked again.
  await companyNames(admin, "b.myshopify.com", [company(1)], now);
  await companyNames(admin, "a.myshopify.com", [company(2)], now + 5 * 60_000);

  expect(asked()).toEqual([[company(1), company(2), DELETED], [company(3)], [company(1)], [company(2)]]);
});

test("all cached: no Shopify call; no ids: no call either", async () => {
  const { admin, asked } = fakeAdmin();
  const now = Date.now();
  await companyNames(admin, "c.myshopify.com", [company(5)], now);
  await companyNames(admin, "c.myshopify.com", [company(5)], now + 1000);
  await companyNames(admin, "c.myshopify.com", [], now);
  expect(asked()).toEqual([[company(5)]]);
});
