import { logger } from "../lib/logger.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { renderToBuffer } from "@react-pdf/renderer";
import db from "../db.server";
import { localDateString } from "../lib/dates";
import { NotFoundError } from "../lib/errors";
import { createI18n } from "../lib/i18n";
import { type Money, formatMoney } from "../lib/money";
import { QuoteDocument } from "../pdf/QuoteDocument";
import { registerFonts } from "../pdf/fonts";
import { getCompanyLocation, getContact } from "../shopify/companies.server";
import { fetchShopInfo } from "../shopify/shop.server";
import { isAllowedLogoUrl } from "./shop.server";

// Everything the PDF shows, already formatted. Buyer names and addresses come live from
// Shopify (D-10) and are never stored.
const loadQuotePdfData = async (
  admin: AdminApiContext,
  shop: string,
  quoteId: string,
  versionNumber?: number,
  locale = "en",
) => {
  const quote = await db.quote.findFirst({
    where: { id: quoteId, shop },
    include: { versions: { include: { lines: { orderBy: { position: "asc" } } } } },
  });
  if (!quote) throw new NotFoundError();
  const version =
    versionNumber === undefined
      ? quote.versions.find((item) => item.id === quote.currentVersionId)
      : quote.versions.find((item) => item.versionNumber === versionNumber);
  if (!version) throw new NotFoundError();

  const [settings, info, location, contact] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shop } }),
    fetchShopInfo(admin),
    getCompanyLocation(admin, quote.companyLocationId),
    getContact(admin, quote.companyContactId),
  ]);
  const i18n = createI18n(locale);
  const money = (value: Money) => formatMoney(value, quote.currencyCode, locale);

  return {
    t: i18n.t,
    locale: i18n.language,
    numberLabel: `${settings.quotePrefix}${quote.number}`,
    version: version.versionNumber,
    issuedAt: localDateString(version.lockedAt ?? version.createdAt, settings.timezone),
    expiresAt: quote.expiresAt ? localDateString(quote.expiresAt, settings.timezone) : null,
    shopName: info.name,
    // Checked again here: a stored value from before the check, or written another way, isn't fetched.
    logoUrl: settings.logoUrl && isAllowedLogoUrl(settings.logoUrl) ? settings.logoUrl : null,
    terms: settings.quoteTerms,
    footer: settings.quoteFooter,
    companyName: location?.company.name ?? "",
    locationName: location?.name ?? "",
    shipTo: location?.shippingAddress ?? null,
    billTo: location?.billingAddress ?? location?.shippingAddress ?? null,
    contactName: contact?.customer?.displayName ?? "",
    lines: version.lines.map((line) => ({
      position: line.position + 1,
      sku: line.sku ?? "",
      title: line.titleSnapshot,
      quantity: line.quantity,
      unitPrice: money(line.overridePrice ?? line.catalogPrice),
      discount: line.discountPct && !line.discountPct.isZero() ? `${line.discountPct.toString()} %` : "",
      lineTotal: money(line.lineTotal),
    })),
    listTotal: money(version.listTotal),
    discountTotal: money(version.discountTotal),
    total: money(version.total),
    note: version.note,
  };
};
type QuotePdfData = Awaited<ReturnType<typeof loadQuotePdfData>>;

const renderQuotePdf = async (data: QuotePdfData) => {
  registerFonts();
  const started = Date.now();
  const pdf = await renderToBuffer(<QuoteDocument q={data} />);
  logger.info({ quote: data.numberLabel, version: data.version, lines: data.lines.length, ms: Date.now() - started }, "quote pdf rendered");
  return pdf;
};

export { loadQuotePdfData, renderQuotePdf };
export type { QuotePdfData };
