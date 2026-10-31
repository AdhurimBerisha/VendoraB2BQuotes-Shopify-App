import Papa from "papaparse";
import { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { enqueue } from "../jobs/queue.server";
import { ConflictError, NotFoundError, UserError } from "../lib/errors";
import { D } from "../lib/money";
import { type VariantPrice, findVariantsBySku, getVariantPrices } from "../shopify/products.server";
import type { StaffActor } from "./actor";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";
import { quantityProblems } from "./pricing";
import { type DraftLineInput, saveDraftLines } from "./version.server";

// Spreadsheet import into a quote's draft version (scenario 10, D-7: merge duplicates and warn).
// Nothing touches the quote until commitImport.

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const INLINE_ROWS = 500; // above this, validate in the background
const SKU_BATCH = 50;

type Column = "sku" | "quantity" | "price" | "discount";
const ALIASES: Record<string, Column> = {
  sku: "sku",
  "item code": "sku",
  "product code": "sku",
  "variant sku": "sku",
  article: "sku",
  quantity: "quantity",
  qty: "quantity",
  amount: "quantity",
  units: "quantity",
  price: "price",
  "unit price": "price",
  "net price": "price",
  discount: "discount",
  "discount %": "discount",
  disc: "discount",
};

type RowStatus = "OK" | "WARNING" | "ERROR" | "MERGED";
type RowCode =
  | "MISSING_SKU"
  | "UNKNOWN_SKU"
  | "AMBIGUOUS_SKU"
  | "INVALID_QUANTITY"
  | "INVALID_PRICE"
  | "INVALID_DISCOUNT"
  | "PRODUCT_NOT_ACTIVE"
  | "GIFT_CARD"
  | "QTY_BELOW_MIN"
  | "QTY_ABOVE_MAX"
  | "QTY_NOT_INCREMENT"
  | "CURRENCY_MISMATCH"
  | "DUPLICATE_MERGED"
  | "DUPLICATE_CONFLICT"
  | "MERGED_INTO"
  | "OUT_OF_STOCK";
type RowResult = { row: number; sku: string; status: RowStatus; codes: RowCode[]; detail?: string };
type ImportReport = {
  rows: RowResult[];
  summary: { lines: number; ok: number; warnings: number; errors: number; merged: number };
};
// A proposed line as stored in Import.lines (JSON, so money stays a string).
type ImportLine = { variantId: string; quantity: number; overridePrice: string | null; discountPct: string | null };

type ParsedRow = { row: number; sku: string; quantity: string; price: string; discount: string };
type CheckedRow = ParsedRow & { qty: number; priceValue: string | null; discountValue: string | null };

// Row numbers match the spreadsheet (header = row 1). Separator, BOM and line endings are handled here.
const parseCsv = (text: string): ParsedRow[] => {
  const result = Papa.parse<Partial<Record<Column, string>>>(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => ALIASES[header.trim().toLowerCase()] ?? `ignored:${header}`,
  });
  const fields = result.meta.fields ?? [];
  if (!fields.includes("sku") || !fields.includes("quantity")) {
    throw new UserError("import.errors.missingColumns");
  }
  if (result.data.length > MAX_ROWS) throw new UserError("import.errors.tooManyRows", { max: MAX_ROWS });
  return result.data.map((record, index) => ({
    row: index + 2,
    sku: (record.sku ?? "").trim(),
    quantity: (record.quantity ?? "").trim(),
    price: (record.price ?? "").trim(),
    discount: (record.discount ?? "").trim().replace(/%$/, "").trim(),
  }));
};

// "12,5" → "12.5"; null when empty.
const decimal = (raw: string) => (raw ? D(raw.replace(",", ".")).toString() : null);

const fieldProblems = (row: ParsedRow): RowCode[] => {
  const codes: RowCode[] = [];
  if (!row.sku) codes.push("MISSING_SKU");
  if (!/^\d+$/.test(row.quantity) || +row.quantity < 1 || +row.quantity > 100_000) codes.push("INVALID_QUANTITY");
  if (row.price && !/^\d{1,10}([.,]\d{1,4})?$/.test(row.price)) codes.push("INVALID_PRICE");
  if (row.discount && (!/^\d{1,3}([.,]\d{1,4})?$/.test(row.discount) || D(row.discount.replace(",", ".")).gt(100))) {
    codes.push("INVALID_DISCOUNT");
  }
  return codes;
};

type ValidateDeps = {
  findBySku: (skus: string[]) => Promise<{ id: string; sku?: string | null }[]>;
  prices: (variantIds: string[]) => Promise<Map<string, VariantPrice>>;
  currency: string;
};

// Field checks → merge duplicates → look up SKUs → per-line checks. Only the deps call Shopify.
const validateRows = async (rows: ParsedRow[], deps: ValidateDeps) => {
  const results = new Map<number, RowResult>();
  const error = (row: { row: number; sku: string }, codes: RowCode[], detail?: string) =>
    results.set(row.row, { row: row.row, sku: row.sku, status: "ERROR", codes, detail });

  // 1. Field checks
  const checked: CheckedRow[] = [];
  for (const row of rows) {
    const codes = fieldProblems(row);
    if (codes.length) error(row, codes);
    else checked.push({ ...row, qty: +row.quantity, priceValue: decimal(row.price), discountValue: decimal(row.discount) });
  }

  // 2. Duplicates (same SKU, any case): same price and discount → one line with the quantities added.
  const groups = new Map<string, CheckedRow[]>();
  for (const row of checked) {
    const key = row.sku.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const merged: (CheckedRow & { rows: number[] })[] = [];
  for (const group of groups.values()) {
    const [first, ...rest] = group;
    const rowList = group.map((row) => row.row);
    if (rest.some((row) => row.priceValue !== first.priceValue || row.discountValue !== first.discountValue)) {
      for (const row of group) error(row, ["DUPLICATE_CONFLICT"], `rows ${rowList.join(", ")}`);
      continue;
    }
    merged.push({ ...first, qty: group.reduce((total, row) => total + row.qty, 0), rows: rowList });
    for (const row of rest) {
      results.set(row.row, { row: row.row, sku: row.sku, status: "MERGED", codes: ["MERGED_INTO"], detail: `row ${first.row}` });
    }
  }

  // 3. SKU lookup, exact (case-insensitive) match only
  const bySku = new Map<string, string[]>();
  for (let i = 0; i < merged.length; i += SKU_BATCH) {
    const batch = merged.slice(i, i + SKU_BATCH).map((row) => row.sku);
    const wanted = new Set(batch.map((sku) => sku.toLowerCase()));
    for (const variant of await deps.findBySku(batch)) {
      const key = (variant.sku ?? "").toLowerCase();
      if (wanted.has(key)) bySku.set(key, [...(bySku.get(key) ?? []), variant.id]);
    }
  }
  const unique = merged.flatMap((row) => {
    const ids = bySku.get(row.sku.toLowerCase()) ?? [];
    return ids.length === 1 ? [ids[0]] : [];
  });
  const prices = await deps.prices([...new Set(unique)]);

  // 4. Per-line checks
  const lines: ImportLine[] = [];
  for (const row of merged) {
    const ids = bySku.get(row.sku.toLowerCase()) ?? [];
    const price = ids.length === 1 ? prices.get(ids[0]) : undefined;
    const codes: RowCode[] = [];
    if (ids.length > 1) codes.push("AMBIGUOUS_SKU");
    else if (!price) codes.push("UNKNOWN_SKU");
    else if (price.status !== "ACTIVE") codes.push("PRODUCT_NOT_ACTIVE");
    else if (price.isGiftCard) codes.push("GIFT_CARD");
    else {
      codes.push(...(quantityProblems(row.qty, price.quantityRule) as RowCode[])); // only QTY_* codes
      if (price.currencyCode !== deps.currency) codes.push("CURRENCY_MISMATCH");
    }
    const detail = row.rows.length > 1 ? `rows ${row.rows.join(", ")} → qty ${row.qty}` : undefined;
    if (codes.length || !price) {
      error(row, codes, detail);
      continue;
    }

    const warnings: RowCode[] = [];
    if (row.rows.length > 1) warnings.push("DUPLICATE_MERGED");
    if (price.tracked && price.inventoryQuantity !== null && price.inventoryQuantity < row.qty) warnings.push("OUT_OF_STOCK");
    lines.push({ variantId: price.id, quantity: row.qty, overridePrice: row.priceValue, discountPct: row.discountValue });
    results.set(row.row, { row: row.row, sku: row.sku, status: warnings.length ? "WARNING" : "OK", codes: warnings, detail });
  }

  const reportRows = [...results.values()].sort((a, b) => a.row - b.row);
  const count = (status: RowStatus) => reportRows.filter((row) => row.status === status).length;
  const report: ImportReport = {
    rows: reportRows,
    summary: { lines: lines.length, ok: count("OK"), warnings: count("WARNING"), errors: count("ERROR"), merged: count("MERGED") },
  };
  return { lines, report };
};

// Validates and stores the report. A failure marks the import FAILED, then rethrows.
const runValidation = async (admin: AdminApiContext, importId: string, text: string) => {
  const imp = await db.import.findUniqueOrThrow({ where: { id: importId } });
  const quote = await db.quote.findFirstOrThrow({ where: { id: imp.quoteId, shop: imp.shop } });
  try {
    const { lines, report } = await validateRows(parseCsv(text), {
      findBySku: (skus) => findVariantsBySku(admin, skus),
      prices: (ids) => getVariantPrices(admin, ids, quote.companyLocationId),
      currency: quote.currencyCode,
    });
    console.log("import validated", { importId, rows: imp.rowCount, ...report.summary });
    return await db.import.update({ where: { id: importId }, data: { status: "READY", lines, report } });
  } catch (error) {
    await db.import.update({ where: { id: importId }, data: { status: "FAILED", error: String(error) } });
    throw error;
  }
};

// Upload: small files are validated now, big ones by the import-csv job.
const startImport = async (actor: StaffActor, quoteId: string, file: File) => {
  requirePermission(actor, "import.run");
  if (file.size > MAX_BYTES) throw new UserError("import.errors.tooLarge", { maxMb: 5 });
  const quote = await db.quote.findFirst({ where: { id: quoteId, shop: actor.shop }, include: { currentVersion: true } });
  if (!quote?.currentVersion) throw new NotFoundError();
  if (quote.currentVersion.lockedAt) throw new UserError("quote.errors.versionLocked");

  const text = await file.text();
  const rows = parseCsv(text); // structure errors are UserErrors, shown before anything is stored
  const imp = await db.import.create({
    data: {
      shop: actor.shop,
      quoteId,
      status: "VALIDATING",
      fileName: file.name.slice(0, 200),
      rowCount: rows.length,
      createdBy: actor.userId,
    },
  });
  console.log("import started", { shop: actor.shop, quoteId, importId: imp.id, rows: rows.length });
  if (rows.length <= INLINE_ROWS) return runValidation(actor.admin, imp.id, text);
  // ponytail: the file text (≤ 5 MB) rides in the job payload; move it to storage if jobs get heavy.
  await enqueue("import-csv", { shop: actor.shop, importId: imp.id, text }, { singletonKey: imp.id });
  return imp;
};

// Confirm: append (same variant → quantities added) or replace the draft's lines.
const commitImport = async (actor: StaffActor, importId: string, mode: "append" | "replace") => {
  requirePermission(actor, "import.run");
  const imp = await db.import.findFirst({ where: { id: importId, shop: actor.shop } });
  if (!imp) throw new NotFoundError();
  // Atomic claim: a double click commits once.
  const claimed = await db.import.updateMany({ where: { id: imp.id, status: "READY" }, data: { status: "COMMITTED" } });
  if (claimed.count !== 1) throw new ConflictError("import.errors.notReady");

  try {
    const quote = await db.quote.findFirstOrThrow({
      where: { id: imp.quoteId, shop: actor.shop },
      include: { currentVersion: { include: { lines: { orderBy: { position: "asc" } } } } },
    });
    const version = quote.currentVersion;
    if (!version) throw new NotFoundError();
    const incoming = (imp.lines as ImportLine[] | null) ?? [];
    const byVariant = new Map<string, DraftLineInput>(
      mode === "replace"
        ? []
        : version.lines.map((line) => [
            line.variantId,
            { variantId: line.variantId, quantity: line.quantity, overridePrice: line.overridePrice, discountPct: line.discountPct },
          ]),
    );
    for (const line of incoming) {
      const existing = byVariant.get(line.variantId);
      byVariant.set(
        line.variantId,
        existing
          ? { ...existing, quantity: existing.quantity + line.quantity }
          : {
              variantId: line.variantId,
              quantity: line.quantity,
              overridePrice: line.overridePrice === null ? null : D(line.overridePrice),
              discountPct: line.discountPct === null ? null : D(line.discountPct),
            },
      );
    }
    // Prices again from Shopify, optimistic lock, locked-version check: all in saveDraftLines.
    await saveDraftLines(actor, quote.id, quote.lockVersion, [...byVariant.values()], version.quoteDiscountPct);
    await db.$transaction(async (tx) => {
      await tx.import.update({ where: { id: imp.id }, data: { lines: Prisma.DbNull } });
      await audit(tx, actor, quote.id, "import.committed", { importId: imp.id, lines: incoming.length, mode });
    });
    console.log("import committed", { shop: actor.shop, importId: imp.id, lines: incoming.length, mode });
    return quote.id;
  } catch (error) {
    await db.import.update({ where: { id: imp.id }, data: { status: "READY" } }); // let them try again
    throw error;
  }
};

const reportToCsv = (report: ImportReport) =>
  Papa.unparse(
    report.rows.map((row) => ({
      row: row.row,
      sku: row.sku,
      status: row.status,
      codes: row.codes.join(" "),
      detail: row.detail ?? "",
    })),
  );

export { INLINE_ROWS, MAX_ROWS, commitImport, parseCsv, reportToCsv, runValidation, startImport, validateRows };
export type { ImportLine, ImportReport, RowCode, RowResult, RowStatus };
