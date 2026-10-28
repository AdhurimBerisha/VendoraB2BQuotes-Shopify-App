// Dev data for the dev store: `npx prisma db seed`. Adds 4 more quotes each run.
import { PrismaClient } from "@prisma/client";

if (process.env.NODE_ENV === "production") throw new Error("Never seed production");

const db = new PrismaClient();

const SHOP = "abstore-hixo2jwg.myshopify.com";
// Real ids from the dev store (roadmap/01 §3).
const SNOWDEVIL = {
  companyId: "gid://shopify/Company/5602083121",
  companyLocationId: "gid://shopify/CompanyLocation/6723666225",
  companyContactId: "gid://shopify/CompanyContact/4183359793",
};
const VARIANTS = [
  {
    variantId: "gid://shopify/ProductVariant/56138653958449",
    productId: "gid://shopify/Product/10809701400881",
    sku: "sku-untracked-1",
    title: "The Inventory Not Tracked Snowboard",
    price: 949.95,
  },
  {
    variantId: "gid://shopify/ProductVariant/56138654253361",
    productId: "gid://shopify/Product/10809701433649",
    sku: null,
    title: "The Minimal Snowboard",
    price: 885.95,
  },
];

const main = async () => {
  await db.shop.upsert({ where: { id: SHOP }, create: { id: SHOP }, update: {} });
  for (const [index, status] of ["DRAFT", "PENDING_APPROVAL", "APPROVED", "DRAFT"].entries()) {
    const quantity = index + 1;
    const total = VARIANTS.reduce((sum, variant) => sum + variant.price * quantity, 0);
    const shop = await db.shop.update({
      where: { id: SHOP },
      data: { nextQuoteNumber: { increment: 1 } },
    });
    const quote = await db.quote.create({
      data: { shop: SHOP, number: shop.nextQuoteNumber - 1, status, currencyCode: "CAD", ...SNOWDEVIL },
    });
    const version = await db.quoteVersion.create({
      data: {
        quoteId: quote.id,
        versionNumber: 1,
        listTotal: total,
        subtotal: total,
        total,
        lines: {
          create: VARIANTS.map((variant, position) => ({
            position,
            variantId: variant.variantId,
            productId: variant.productId,
            sku: variant.sku,
            titleSnapshot: variant.title,
            quantity,
            catalogPrice: variant.price,
            lineTotal: variant.price * quantity,
          })),
        },
      },
    });
    await db.quote.update({ where: { id: quote.id }, data: { currentVersionId: version.id } });
    console.log("seeded quote", { number: quote.number, status });
  }
};

main().finally(() => db.$disconnect());
