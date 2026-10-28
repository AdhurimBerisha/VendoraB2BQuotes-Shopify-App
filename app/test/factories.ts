import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { D } from "../lib/money";
import type { StaffActor } from "../models/actor";

// Each test file gets its own random shop; clean up with redactShop(shop.id).
const testShop = (overrides: Partial<Prisma.ShopCreateInput> = {}) =>
  db.shop.create({ data: { id: `vitest-${randomUUID()}.myshopify.com`, ...overrides } });

const staff = (
  shop: string,
  admin: AdminApiContext,
  role: StaffActor["role"] = "OWNER",
  userId = 1n,
): StaffActor => ({ type: "STAFF", shop, userId, name: "Test Staff", role, locale: "en", admin });

// A quote with one version and `lines` lines of 2 × 10.00. Takes its number from the
// shop's counter (creating the Shop row if needed), like createQuote.
const testQuote = async (
  shop: string,
  opts: { lines?: number; overrides?: Partial<Prisma.QuoteUncheckedCreateInput> } = {},
) => {
  const { nextQuoteNumber } = await db.shop.upsert({
    where: { id: shop },
    create: { id: shop, nextQuoteNumber: 1002 },
    update: { nextQuoteNumber: { increment: 1 } },
  });
  const quote = await db.quote.create({
    data: {
      shop,
      number: nextQuoteNumber - 1,
      companyId: "gid://shopify/Company/1",
      companyLocationId: "gid://shopify/CompanyLocation/1",
      companyContactId: "gid://shopify/CompanyContact/1",
      contactCustomerId: "gid://shopify/Customer/1",
      currencyCode: "USD",
      ...opts.overrides,
    },
  });
  const version = await db.quoteVersion.create({
    data: {
      quoteId: quote.id,
      versionNumber: 1,
      lines: {
        create: Array.from({ length: opts.lines ?? 1 }, (_, i) => ({
          position: i,
          variantId: `gid://shopify/ProductVariant/${i + 1}`,
          productId: `gid://shopify/Product/${i + 1}`,
          sku: `SKU-${i + 1}`,
          titleSnapshot: `Product ${i + 1}`,
          quantity: 2,
          catalogPrice: D(10),
          lineTotal: D(20),
        })),
      },
    },
  });
  return db.quote.update({ where: { id: quote.id }, data: { currentVersionId: version.id } });
};

export { staff, testQuote, testShop };
