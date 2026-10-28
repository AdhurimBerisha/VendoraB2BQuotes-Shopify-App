import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { fetchShopInfo } from "../shopify/shop.server";

// Called after Shopify auth (install, reinstall, token refresh). Safe to call many times.
const upsertShopOnInstall = async (admin: AdminApiContext, shop: string) => {
  const info = await fetchShopInfo(admin);
  const data = {
    shopGid: info.id,
    timezone: info.ianaTimezone,
    currencyCode: info.currencyCode,
    uninstalledAt: null,
  };
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop, ...data },
    update: data,
  });
  console.log("shop upserted", { shop, timezone: data.timezone, currency: data.currencyCode });
};

// Sessions go now; data stays until shop/redact (~48 h later) so a quick reinstall keeps it.
const markUninstalled = async (shop: string) => {
  await db.$transaction([
    db.session.deleteMany({ where: { shop } }),
    db.shop.updateMany({ where: { id: shop }, data: { uninstalledAt: new Date() } }),
  ]);
};

const getShop = (shop: string) => db.shop.findUnique({ where: { id: shop } });

export { getShop, markUninstalled, upsertShopOnInstall };
