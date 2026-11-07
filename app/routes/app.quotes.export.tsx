import type { LoaderFunctionArgs } from "react-router";
import Papa from "papaparse";
import db from "../db.server";
import { toShopifyAmount } from "../lib/money";
import { getActor } from "../models/actor.server";
import { requirePermission } from "../models/permissions";
import { listFiltersSchema, quoteLabel, quoteWhere, searchFilters } from "../models/quote.server";
import { getShop } from "../models/shop.server";
import { listStaff } from "../models/staff.server";
import { companyNames } from "../shopify/companies.server";

// ponytail: one request, capped at MAX_ROWS; a background export job if shops outgrow it.
const MAX_ROWS = 10_000;
const NAMES_BATCH = 250; // nodes(ids:) limit

// Resource route (no UI): the quote list's filters → CSV (G-11). Fetched by the list page.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "export.all");
  const filters = listFiltersSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const prefix = (await getShop(actor.shop))?.quotePrefix ?? "Q-";
  const search = await searchFilters(actor, filters.q, prefix);

  const quotes = await db.quote.findMany({
    where: quoteWhere(actor.shop, { ...search, status: filters.status }),
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: MAX_ROWS,
    include: { currentVersion: { select: { versionNumber: true, total: true } } },
  });
  const companyIds = [...new Set(quotes.map((quote) => quote.companyId))];
  const names = new Map<string, string>();
  for (let i = 0; i < companyIds.length; i += NAMES_BATCH) {
    for (const [id, name] of await companyNames(actor.admin, companyIds.slice(i, i + NAMES_BATCH))) names.set(id, name);
  }
  const staff = new Map((await listStaff(actor.shop)).map((member) => [member.shopifyUserId, member.displayName]));

  const csv = Papa.unparse(
    quotes.map((quote) => ({
      number: quoteLabel(prefix, quote.number),
      company: names.get(quote.companyId) ?? "",
      status: quote.status,
      version: quote.currentVersion?.versionNumber ?? "",
      currency: quote.currencyCode,
      total: quote.currentVersion ? toShopifyAmount(quote.currentVersion.total, quote.currencyCode) : "",
      rep: quote.assignedToUserId === null ? "" : (staff.get(quote.assignedToUserId) ?? ""),
      expires: quote.expiresAt?.toISOString() ?? "",
      updated: quote.updatedAt.toISOString(),
    })),
    { escapeFormulae: true }, // a company name starting with = + - @ must not run as a spreadsheet formula
  );
  console.log("quotes exported", { shop: actor.shop, rows: quotes.length });
  return new Response(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="vendora-quotes.csv"',
      "X-Content-Type-Options": "nosniff",
    },
  });
};
