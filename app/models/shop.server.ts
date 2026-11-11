import { logger } from "../lib/logger.server";
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
    name: info.name,
    timezone: info.ianaTimezone,
    currencyCode: info.currencyCode,
    uninstalledAt: null,
  };
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop, ...data },
    update: data,
  });
  logger.info({ shop, timezone: data.timezone, currency: data.currencyCode }, "shop upserted");
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
  importSubmittedDrafts: z.boolean(),
  notifyEmails: z.array(z.email()).max(20),
});
type GeneralSettings = z.infer<typeof generalSettingsSchema>;

const generalSettingsFromForm = (form: FormData): GeneralSettings =>
  generalSettingsSchema.parse({
    quotePrefix: String(form.get("quotePrefix") ?? "").toUpperCase(),
    nextQuoteNumber: form.get("nextQuoteNumber"),
    defaultExpiryDays: form.get("defaultExpiryDays"),
    reserveInventory: form.get("reserveInventory") === "on",
    importSubmittedDrafts: form.get("importSubmittedDrafts") === "on",
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
  logger.info({ shop: actor.shop }, "general settings saved");
};

// The server fetches the logo when rendering a PDF, so only Shopify's file CDN is allowed:
// any other host could point the fetch at internal addresses (SSRF).
const isAllowedLogoUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "cdn.shopify.com" && !url.username && !url.port;
  } catch {
    return false;
  }
};

// Settings → Branding, shown on PDFs. Empty fields clear the value.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null);
const brandingSchema = z.object({
  logoUrl: z
    .string()
    .trim()
    .max(2000)
    .refine((value) => value === "" || isAllowedLogoUrl(value), "settings.errors.logoUrl")
    .transform((value) => value || null),
  quoteTerms: optionalText(4000),
  quoteFooter: optionalText(200),
});
type Branding = z.infer<typeof brandingSchema>;

const brandingFromForm = (form: FormData): Branding =>
  brandingSchema.parse({
    logoUrl: String(form.get("logoUrl") ?? ""),
    quoteTerms: String(form.get("quoteTerms") ?? ""),
    quoteFooter: String(form.get("quoteFooter") ?? ""),
  });

const saveBranding = async (actor: StaffActor, branding: Branding) => {
  requirePermission(actor, "settings.manage");
  await db.$transaction(async (tx) => {
    await tx.shop.update({ where: { id: actor.shop }, data: branding });
    await audit(tx, actor, null, "settings.branding_changed", { logo: !!branding.logoUrl });
  });
  logger.info({ shop: actor.shop }, "branding saved");
};

export {
  brandingFromForm,
  generalSettingsFromForm,
  getShop,
  isAllowedLogoUrl,
  isInstalled,
  markUninstalled,
  saveBranding,
  saveGeneralSettings,
  upsertShopOnInstall,
};
export type { Branding, GeneralSettings };
