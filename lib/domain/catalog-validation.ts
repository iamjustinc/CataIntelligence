import { createHash } from "node:crypto";
import type { ParsedCsv } from "@/lib/csv";

export const CATALOG_FIELDS = ["merchant_sku", "title", "description", "merchant_category_path", "brand", "gtin", "package_size", "price", "currency"] as const;
export type CatalogField = (typeof CATALOG_FIELDS)[number];
export const REQUIRED_FIELDS: readonly CatalogField[] = ["merchant_sku", "title"];
export const FIELD_LABELS: Record<CatalogField, string> = {
  merchant_sku: "Merchant SKU",
  title: "Title",
  description: "Description",
  merchant_category_path: "Merchant category path",
  brand: "Brand",
  gtin: "GTIN",
  package_size: "Package size",
  price: "Price",
  currency: "Currency",
};
export const MAX_CATALOG_BYTES = 10 * 1024 * 1024;
export const MAX_CATALOG_ROWS = 5000;

/** Canonical field -> source column header. */
export type ColumnMap = Partial<Record<CatalogField, string>>;
/** For conflicting rows that share a SKU: SKU -> source row number to keep. */
export type DuplicateResolutions = Record<string, number>;

const ALIASES: Record<CatalogField, string[]> = {
  merchant_sku: ["merchant_sku", "sku", "item code", "item_code", "item number", "product id", "product_id", "id"],
  title: ["title", "name", "product name", "product_name", "item name", "product title"],
  description: ["description", "details", "desc", "long description", "product description"],
  merchant_category_path: ["merchant_category_path", "category", "category path", "category_path", "dept", "department"],
  brand: ["brand", "maker", "manufacturer"],
  gtin: ["gtin", "upc", "ean", "barcode"],
  package_size: ["package_size", "size", "pack", "pack size", "package size"],
  price: ["price", "retail", "retail price", "unit price"],
  currency: ["currency", "cur", "currency code", "currency_code"],
};

/** Suggests a column mapping from header names. The user confirms or changes it before validation. */
export function suggestColumnMap(header: string[]): ColumnMap {
  const map: ColumnMap = {};
  const used = new Set<string>();
  for (const field of CATALOG_FIELDS) {
    const match = header.find((h) => !used.has(h) && ALIASES[field].includes(h.trim().toLowerCase()));
    if (match) {
      map[field] = match;
      used.add(match);
    }
  }
  return map;
}

/** Whitespace and Unicode normalization that preserves case; source values are stored separately. */
export const clean = (value: string | undefined) => (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
/** Case-folded form used for comparison and retrieval. */
export const fold = (value: string) => clean(value).toLowerCase();

export interface ListingFields {
  sku: string;
  title: string;
  description: string | null;
  merchantCategoryPath: string | null;
  brand: string | null;
  gtin: string | null;
  packageSize: string | null;
  price: string | null;
  currency: string | null;
}

/**
 * Hash of the fields that affect classification. Price and currency are excluded: a price-only
 * change does not require a new review (PRD TAX04).
 */
export function classificationHash(f: ListingFields): string {
  const parts = [f.title, f.description, f.merchantCategoryPath, f.brand, f.packageSize, f.gtin].map((v) => fold(v ?? ""));
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
const fullHash = (f: ListingFields) => createHash("sha256").update(JSON.stringify([classificationHash(f), f.price, f.currency])).digest("hex");

export interface CatalogIssue {
  row: number;
  sku: string | null;
  field: CatalogField | null;
  code: string;
  message: string;
}
export interface AcceptedRow {
  row: number;
  raw: Record<string, string>;
  fields: ListingFields;
  contentHash: string;
}
export interface DuplicateConflict {
  sku: string;
  selectedRow: number | null;
  rows: { row: number; title: string; description: string | null; price: string | null }[];
}
export interface CatalogValidation {
  /** Problems with the mapping itself. When present no rows are evaluated. */
  mappingErrors: string[];
  counts: { input: number; accepted: number; rejected: number; collapsed: number };
  issues: CatalogIssue[];
  conflicts: DuplicateConflict[];
  accepted: AcceptedRow[];
}

const PRICE = /^\d{1,10}(\.\d{1,4})?$/;
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/**
 * Validates every row of a catalog file against a column mapping (PRD TAX03, TAX04).
 * Count conservation always holds: input = accepted + rejected + collapsed.
 */
export function validateCatalog(csv: ParsedCsv, map: ColumnMap, resolutions: DuplicateResolutions = {}): CatalogValidation {
  const empty = { counts: { input: csv.records.length, accepted: 0, rejected: 0, collapsed: 0 }, issues: [], conflicts: [], accepted: [] };
  const mappingErrors: string[] = [];
  const index = new Map(csv.header.map((h, i) => [h, i]));
  for (const field of REQUIRED_FIELDS) if (!map[field]) mappingErrors.push(`Map a column to ${FIELD_LABELS[field]}; it is required.`);
  const seen = new Map<string, CatalogField>();
  for (const field of CATALOG_FIELDS) {
    const source = map[field];
    if (!source) continue;
    if (!index.has(source)) mappingErrors.push(`Column "${source}" (mapped to ${FIELD_LABELS[field]}) is not in the file.`);
    else if (seen.has(source)) mappingErrors.push(`Column "${source}" is mapped to both ${FIELD_LABELS[seen.get(source)!]} and ${FIELD_LABELS[field]}.`);
    seen.set(source, field);
  }
  if (csv.records.length > MAX_CATALOG_ROWS) mappingErrors.push(`A catalog upload may contain at most ${MAX_CATALOG_ROWS} rows; this file has ${csv.records.length}.`);
  if (mappingErrors.length > 0) return { ...empty, mappingErrors };

  const issues: CatalogIssue[] = [];
  const valid: AcceptedRow[] = [];
  let rejected = 0;
  for (const record of csv.records) {
    const cell = (field: CatalogField) => (map[field] ? clean(record.cells[index.get(map[field]!)!]) : "");
    const sku = cell("merchant_sku");
    const rowIssues: CatalogIssue[] = [];
    const issue = (field: CatalogField, code: string, message: string) => rowIssues.push({ row: record.row, sku: sku || null, field, code, message });
    if (!sku) issue("merchant_sku", "missing_sku", "Merchant SKU is required.");
    else if (sku.length > 200) issue("merchant_sku", "sku_too_long", "Merchant SKU must be at most 200 characters.");
    const title = cell("title");
    if (!title) issue("title", "missing_title", "Title is required.");

    const priceRaw = cell("price");
    const currencyRaw = cell("currency");
    let price: string | null = null;
    if (priceRaw) {
      if (/^-\s*\d/.test(priceRaw)) issue("price", "negative_price", `Price "${priceRaw}" is negative; price must be zero or more.`);
      else if (!PRICE.test(priceRaw)) issue("price", "invalid_price", `Price "${priceRaw}" is not a plain decimal number.`);
      else price = priceRaw;
    }
    let currency: string | null = null;
    if (currencyRaw) {
      if (!/^[A-Za-z]{3}$/.test(currencyRaw)) issue("currency", "invalid_currency", `Currency "${currencyRaw}" is not a three-letter code.`);
      else currency = currencyRaw.toUpperCase();
    } else if (priceRaw) issue("currency", "missing_currency", "Currency is required when a price is present.");

    const gtinRaw = cell("gtin");
    if (gtinRaw && !(/^\d+$/.test(gtinRaw) && GTIN_LENGTHS.has(gtinRaw.length))) issue("gtin", "invalid_gtin", `GTIN "${gtinRaw}" must be 8, 12, 13 or 14 digits.`);

    if (rowIssues.length > 0) {
      issues.push(...rowIssues);
      rejected++;
      continue;
    }
    const fields: ListingFields = {
      sku,
      title,
      description: cell("description") || null,
      merchantCategoryPath: cell("merchant_category_path") || null,
      brand: cell("brand") || null,
      gtin: gtinRaw || null,
      packageSize: cell("package_size") || null,
      price,
      currency,
    };
    // Original strings exactly as supplied, keyed by source header.
    const raw: Record<string, string> = {};
    csv.header.forEach((h, i) => (raw[h] = record.cells[i] ?? ""));
    valid.push({ row: record.row, raw, fields, contentHash: classificationHash(fields) });
  }

  // Duplicate SKUs among otherwise valid rows.
  const bySku = new Map<string, AcceptedRow[]>();
  for (const row of valid) bySku.set(row.fields.sku, [...(bySku.get(row.fields.sku) ?? []), row]);
  const accepted: AcceptedRow[] = [];
  const conflicts: DuplicateConflict[] = [];
  let collapsed = 0;
  for (const [sku, rows] of bySku) {
    const distinct = new Map<string, AcceptedRow>();
    for (const row of rows) {
      const h = fullHash(row.fields);
      if (distinct.has(h)) collapsed++;
      else distinct.set(h, row);
    }
    const variants = [...distinct.values()];
    if (variants.length === 1) {
      accepted.push(variants[0]);
      continue;
    }
    const chosen = variants.find((v) => v.row === resolutions[sku]) ?? null;
    conflicts.push({ sku, selectedRow: chosen?.row ?? null, rows: variants.map((v) => ({ row: v.row, title: v.fields.title, description: v.fields.description, price: v.fields.price })) });
    for (const v of variants) {
      if (v === chosen) accepted.push(v);
      else {
        rejected++;
        issues.push({
          row: v.row,
          sku,
          field: "merchant_sku",
          code: chosen ? "duplicate_not_selected" : "conflicting_duplicate",
          message: chosen ? `Row ${chosen.row} was selected for SKU "${sku}"; this conflicting row is excluded.` : `SKU "${sku}" appears on rows ${variants.map((x) => x.row).join(", ")} with different content. Select the row to keep or correct the file.`,
        });
      }
    }
  }
  accepted.sort((a, b) => a.row - b.row);
  issues.sort((a, b) => a.row - b.row);
  return { mappingErrors, counts: { input: csv.records.length, accepted: accepted.length, rejected, collapsed }, issues, conflicts, accepted };
}

/** Hash of the active population: order-independent over (SKU, content hash). */
export function populationHash(entries: { sku: string; contentHash: string }[]): string {
  const lines = entries.map((e) => `${e.sku}\u0000${e.contentHash}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
