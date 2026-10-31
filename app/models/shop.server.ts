import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { z } from "zod";
import { UserError } from "../lib/errors";
import { fetchShopInfo } from "../shopify/shop.server";
import type { StaffActor } from "./actor";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";

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

const isInstalled = async (shop: string) => {
  const record = await getShop(shop);
  return record !== null && record.uninstalledAt === null;
};

// Settings → General. Emails come as one comma-separated field.
const generalSettingsSchema = z.object({
  quotePrefix: z.string().trim().regex(/^[A-Z0-9-]{1,8}$/, "settings.errors.prefix"),
  nextQuoteNumber: z.coerce.number().int().min(1).max(99_999_999),
  defaultExpiryDays: z.coerce.number().int().min(1).max(365),
  reserveInventory: z.boolean(),
  notifyEmails: z.array(z.email()).max(20),
});
type GeneralSettings = z.infer<typeof generalSettingsSchema>;

const generalSettingsFromForm = (form: FormData): GeneralSettings =>
  generalSettingsSchema.parse({
    quotePrefix: String(form.get("quotePrefix") ?? "").toUpperCase(),
    nextQuoteNumber: form.get("nextQuoteNumber"),
    defaultExpiryDays: form.get("defaultExpiryDays"),
    reserveInventory: form.get("reserveInventory") === "on",
    notifyEmails: String(form.get("notifyEmails") ?? "")
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean),
  });

const saveGeneralSettings = async (actor: StaffActor, settings: GeneralSettings) => {
  requirePermission(actor, "settings.manage");
  await db.$transaction(async (tx) => {
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: actor.shop } });
    // Lower numbers could repeat one already used (quote numbers are unique per shop).
    if (settings.nextQuoteNumber < shop.nextQuoteNumber) {
      throw new UserError("settings.errors.numberTooLow", { min: shop.nextQuoteNumber });
    }
    await tx.shop.update({ where: { id: actor.shop }, data: settings });
    await audit(tx, actor, null, "settings.general_changed", settings);
  });
  console.log("general settings saved", { shop: actor.shop });
};

export {
  generalSettingsFromForm,
  getShop,
  isInstalled,
  markUninstalled,
  saveGeneralSettings,
  upsertShopOnInstall,
};
export type { GeneralSettings };
