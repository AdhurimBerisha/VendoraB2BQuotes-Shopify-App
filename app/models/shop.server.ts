import { logger } from "../lib/logger.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { z } from "zod";
import { UserError } from "../lib/errors";
import { ShopifyDenied } from "../shopify/client.server";
import { searchCompanies } from "../shopify/companies.server";
import { fetchShopInfo } from "../shopify/shop.server";
import type { StaffActor } from "./actor";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";

// Called after Shopify auth (install, reinstall, token refresh). Safe to call many times.
const upsertShopOnInstall = async (admin: AdminApiContext, shop: string) => {
  const info = await fetchShopInfo(admin);
  // M5.3: back before shop/redact deleted the data (~48 h after uninstall): the quotes are still here.
  const existing = await db.shop.findUnique({ where: { id: shop }, select: { uninstalledAt: true } });
  const reinstalled = !!existing?.uninstalledAt;
  const data = {
    shopGid: info.id,
    name: info.name,
    timezone: info.ianaTimezone,
    currencyCode: info.currencyCode,
    uninstalledAt: null,
    // The store may have changed while the app was gone: start with a clean B2B flag.
    ...(reinstalled && { welcomeBack: true, b2bUnavailable: false }),
  };
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop, ...data },
    update: data,
  });
  logger.info({ shop, timezone: data.timezone, currency: data.currencyCode, reinstalled }, "shop upserted");
  return { reinstalled };
};

// True once after a reinstall (the dashboard's "welcome back" note): reading the flag clears it.
const takeWelcomeBack = async (shop: string) => {
  const { count } = await db.shop.updateMany({ where: { id: shop, welcomeBack: true }, data: { welcomeBack: false } });
  return count === 1;
};

// M5.3 B2B loss. A store that leaves Plus loses companies: Shopify then answers company reads
// with ACCESS_DENIED. The flag shows a banner (app.tsx) and blocks sending (assertB2b).
const setB2bUnavailable = async (shop: string, unavailable: boolean) => {
  const { count } = await db.shop.updateMany({
    where: { id: shop, b2bUnavailable: !unavailable },
    data: { b2bUnavailable: unavailable },
  });
  if (count) logger.warn({ shop, unavailable }, "b2b availability changed");
};

// Asks Shopify whether the store (still) has B2B and saves the answer. Used by the nightly
// reconcile, after a denied sync, and on page loads while the flag is set (so it clears itself).
const checkB2b = async (admin: AdminApiContext, shop: string) => {
  try {
    await searchCompanies(admin);
  } catch (error) {
    if (!(error instanceof ShopifyDenied)) throw error;
    await setB2bUnavailable(shop, true);
    return false;
  }
  await setB2bUnavailable(shop, false);
  return true;
};

// For pages that read companies: a denied read flags the shop and the page carries on with
// `fallback`, so the quotes stay visible (without company names).
const orB2bLost = async <T>(shop: string, fallback: T, read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ShopifyDenied)) throw error;
    await setB2bUnavailable(shop, true);
    return fallback;
  }
};

const assertB2b = async (shop: string) => {
  const record = await db.shop.findUnique({ where: { id: shop }, select: { b2bUnavailable: true } });
  if (record?.b2bUnavailable) throw new UserError("eligibility.errors.b2bUnavailable");
};

// Scopes the app asks for (SCOPES) that the session's token doesn't have. Shopify may list only
// write_x when the app asked for read_x and write_x.
const missingScopes = (grantedScopes: string | undefined) => {
  const granted = (grantedScopes ?? "").split(",").map((scope) => scope.trim());
  const required = (process.env.SCOPES ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
  return required.filter((scope) => !granted.includes(scope) && !granted.includes(scope.replace(/^read_/, "write_")));
};

// Sessions go now; data stays until shop/redact (~48 h later) so a quick reinstall keeps it.
const markUninstalled = async (shop: string) => {
  await db.$transaction([
    db.session.deleteMany({ where: { shop } }),
    db.shop.updateMany({ where: { id: shop }, data: { uninstalledAt: new Date() } }),
  ]);
};

// M10.1 shop/update webhook: the merchant changed the store's name, currency or time zone.
// A missing/null field keeps the stored value; an unknown zone is ignored (Intl would throw on every date).
// ponytail: last delivery wins; Shopify can deliver out of order, add an updated_at check if that ever matters.
const shopUpdateSchema = z.object({
  name: z.string().min(1).nullish(),
  currency: z.string().length(3).nullish(),
  iana_timezone: z.string().min(1).nullish(),
});

const isTimeZone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

const updateShopFromWebhook = async (shop: string, payload: unknown) => {
  const parsed = shopUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    logger.warn({ shop, issues: parsed.error.issues.length }, "shop/update payload not understood, ignored");
    return;
  }
  const { name, currency, iana_timezone: timezone } = parsed.data;
  if (timezone && !isTimeZone(timezone)) logger.warn({ shop, timezone }, "shop/update unknown time zone, kept the old one");
  const data = {
    ...(name && { name }),
    ...(currency && { currencyCode: currency }),
    ...(timezone && isTimeZone(timezone) && { timezone }),
  };
  if (Object.keys(data).length === 0) return;
  const { count } = await db.shop.updateMany({ where: { id: shop, uninstalledAt: null }, data });
  logger.info({ shop, timezone: data.timezone, currency: data.currencyCode, updated: count }, "shop info refreshed");
};

const getShop = (shop: string) => db.shop.findUnique({ where: { id: shop } });

const isInstalled = async (shop: string) => {
  const record = await getShop(shop);
  return record !== null && record.uninstalledAt === null;
};

// M10.3 follow-up days: an empty field is off (null).
const optionalDays = z.preprocess(
  (value) => (value === null || String(value).trim() === "" ? null : value),
  z.coerce.number().int().min(1).max(90).nullable(),
);

// Settings → General. Emails come as one comma-separated field.
const generalSettingsSchema = z.object({
  quotePrefix: z.string().trim().regex(/^[A-Z0-9-]{1,8}$/, "settings.errors.prefix"),
  nextQuoteNumber: z.coerce.number().int().min(1).max(99_999_999),
  defaultExpiryDays: z.coerce.number().int().min(1).max(365),
  followUpNotViewedDays: optionalDays,
  followUpNotOrderedDays: optionalDays,
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
    followUpNotViewedDays: form.get("followUpNotViewedDays"),
    followUpNotOrderedDays: form.get("followUpNotOrderedDays"),
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
  assertB2b,
  brandingFromForm,
  checkB2b,
  generalSettingsFromForm,
  getShop,
  isAllowedLogoUrl,
  isInstalled,
  markUninstalled,
  missingScopes,
  orB2bLost,
  saveBranding,
  saveGeneralSettings,
  takeWelcomeBack,
  updateShopFromWebhook,
  upsertShopOnInstall,
};
export type { Branding, GeneralSettings };
