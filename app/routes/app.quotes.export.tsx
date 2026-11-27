import { logger } from "../lib/logger.server";
import type { LoaderFunctionArgs } from "react-router";
import Papa from "papaparse";
import db from "../db.server";
import { type Money, toShopifyAmount } from "../lib/money";
import { getActor } from "../models/actor.server";
import { audit } from "../models/audit.server";
import { requirePermission } from "../models/permissions";
import { marginOf } from "../models/pricing";
import { listFiltersSchema, quoteLabel, quoteWhere, searchFilters, viewFilters } from "../models/quote.server";
import { getShop, orB2bLost } from "../models/shop.server";
import { listStaff } from "../models/staff.server";
import { companyNames } from "../shopify/companies.server";
import { canViewCosts } from "../shopify/products.server";

// ponytail: one request, capped at MAX_ROWS; a background export job if shops outgrow it.
const MAX_ROWS = 10_000;
const NAMES_BATCH = 250; // nodes(ids:) limit

type ExportQuote = {
  id: string;
  currencyCode: string;
  companyId: string;
  companyLocationId: string;
  createdAt: Date;
  currentVersion: { id: string; subtotal: Money; total: Money } | null;
};

const NO_LINE = { sku: "", product: "", quantity: "", unitPrice: "", discountPct: "", lineTotal: "" };

// Each quote row repeated once per line of its current version (once, with empty line columns,
// when it has none). Lines belong to the quotes already filtered by shop.
// costCurrency (M10.2): the shop's currency when this staff member may see costs, else null (no
// cost columns). Quotes in another currency get empty cost cells.
const withLineColumns = async <Row extends object>(quotes: ExportQuote[], quoteRows: Row[], costCurrency: string | null) => {
  const versionIds = quotes.flatMap((quote) => (quote.currentVersion ? [quote.currentVersion.id] : []));
  const lines = await db.quoteLine.findMany({
    where: { versionId: { in: versionIds } },
    orderBy: [{ versionId: "asc" }, { position: "asc" }],
  });
  const byVersion = new Map<string, typeof lines>();
  for (const line of lines) byVersion.set(line.versionId, [...(byVersion.get(line.versionId) ?? []), line]);

  return quotes.flatMap((quote, index) => {
    const row = {
      ...quoteRows[index],
      quoteId: quote.id,
      companyId: quote.companyId,
      companyLocationId: quote.companyLocationId,
      created: quote.createdAt.toISOString(),
    };
    const quoteLines = byVersion.get(quote.currentVersion?.id ?? "") ?? [];
    const costColumns = costCurrency === null ? {} : { unitCost: "", marginPct: "" };
    if (quoteLines.length === 0) return [{ ...row, ...NO_LINE, ...costColumns }];
    const version = quote.currentVersion;
    const withCosts = costCurrency === quote.currencyCode && version !== null;
    return quoteLines.map((line) => ({
      ...row,
      sku: line.sku ?? "",
      product: line.titleSnapshot,
      quantity: String(line.quantity),
      unitPrice: toShopifyAmount(line.overridePrice ?? line.catalogPrice, quote.currencyCode),
      discountPct: line.discountPct?.toString() ?? "",
      lineTotal: toShopifyAmount(line.lineTotal, quote.currencyCode),
      ...costColumns,
      ...(withCosts && line.unitCost
        ? {
            unitCost: toShopifyAmount(line.unitCost, quote.currencyCode),
            marginPct: marginOf([line], version.subtotal, version.total).marginPct?.toString() ?? "",
          }
        : {}),
    }));
  });
};

// Resource route (no UI): the quote list's filters → CSV (G-11). Fetched by the list page.
// With ?lines=1 (Settings → Export all quotes, M5.3): one row per line of each quote's current
// version, plus the ids, so a merchant can take all their data with them.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "export.all");
  const params = new URL(request.url).searchParams;
  const withLines = params.has("lines");
  const filters = listFiltersSchema.parse(Object.fromEntries(params));
  const shop = await getShop(actor.shop);
  const prefix = shop?.quotePrefix ?? "Q-";
  const search = await searchFilters(actor, filters.q, prefix);

  const quotes = await db.quote.findMany({
    where: quoteWhere(actor.shop, { ...search, status: filters.status, and: await viewFilters(actor, filters, shop) }),
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: MAX_ROWS,
    include: { currentVersion: { select: { id: true, versionNumber: true, subtotal: true, total: true } } },
  });
  const companyIds = [...new Set(quotes.map((quote) => quote.companyId))];
  const names = new Map<string, string>();
  // M5.3: a store that lost B2B can't read company names; the export still works without them.
  await orB2bLost(actor.shop, undefined, async () => {
    for (let i = 0; i < companyIds.length; i += NAMES_BATCH) {
      for (const [id, name] of await companyNames(actor.admin, actor.shop, companyIds.slice(i, i + NAMES_BATCH))) names.set(id, name);
    }
  });
  const staff = new Map((await listStaff(actor.shop)).map((member) => [member.shopifyUserId, member.displayName]));

  const quoteRows = quotes.map((quote) => ({
    number: quoteLabel(prefix, quote.number),
    company: names.get(quote.companyId) ?? "",
    status: quote.status,
    version: quote.currentVersion?.versionNumber ?? "",
    currency: quote.currencyCode,
    total: quote.currentVersion ? toShopifyAmount(quote.currentVersion.total, quote.currencyCode) : "",
    rep: quote.assignedToUserId === null ? "" : (staff.get(quote.assignedToUserId) ?? ""),
    expires: quote.expiresAt?.toISOString() ?? "",
    updated: quote.updatedAt.toISOString(),
  }));
  // M10.2: cost columns only for staff whose Shopify account may view product costs.
  const seesCosts = withLines && actor.userId !== null && (await canViewCosts(actor.admin, actor.shop, actor.userId.toString()));
  const rows = withLines ? await withLineColumns(quotes, quoteRows, seesCosts ? (shop?.currencyCode ?? null) : null) : quoteRows;

  // escapeFormulae: a company name starting with = + - @ must not run as a spreadsheet formula.
  const csv = Papa.unparse(rows, { escapeFormulae: true });
  logger.info({ shop: actor.shop, quotes: quotes.length, rows: rows.length, withLines }, "quotes exported");
  // M5.4: exports are the access log for protected customer data (who took which data out, when).
  await audit(db, actor, null, "data.exported", { quotes: quotes.length, rows: rows.length, withLines });
  return new Response(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="vendora-quotes.csv"',
      "X-Content-Type-Options": "nosniff",
    },
  });
};
