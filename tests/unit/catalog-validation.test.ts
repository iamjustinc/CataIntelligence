import { describe, expect, it } from "vitest";
import { WALKTHROUGH_CSV } from "@/fixtures/generate";
import { parseCsv } from "@/lib/csv";
import { classificationHash, suggestColumnMap, validateCatalog, type ColumnMap } from "@/lib/domain/catalog-validation";

const csv = parseCsv(WALKTHROUGH_CSV);
const map: ColumnMap = { merchant_sku: "Item Code", title: "Product Name", description: "Details", merchant_category_path: "Dept", brand: "Maker", package_size: "Pack", price: "Retail", currency: "Cur" };
const conserved = (v: ReturnType<typeof validateCatalog>) => v.counts.accepted + v.counts.rejected + v.counts.collapsed === v.counts.input;

describe("catalog validation (TAX03, TAX04, AT01)", () => {
  it("suggests a mapping for canonical headers and for common aliases", () => {
    expect(suggestColumnMap(["merchant_sku", "title", "price", "currency"])).toEqual({ merchant_sku: "merchant_sku", title: "title", price: "price", currency: "currency" });
    expect(suggestColumnMap(csv.header)).toEqual(map);
  });
  it("requires SKU and title to be mapped before any row is evaluated", () => {
    const v = validateCatalog(csv, { merchant_sku: "Item Code" });
    expect(v.mappingErrors).toEqual(["Map a column to Title; it is required."]);
    expect(v.counts).toEqual({ input: 14, accepted: 0, rejected: 0, collapsed: 0 });
    expect(validateCatalog(csv, { merchant_sku: "Nope", title: "Product Name" }).mappingErrors[0]).toContain('"Nope"');
    expect(validateCatalog(csv, { merchant_sku: "Item Code", title: "Item Code" }).mappingErrors[0]).toContain("mapped to both");
  });
  it("reports row-specific errors, collapses exact duplicates and conserves counts", () => {
    const v = validateCatalog(csv, map);
    expect(v.issues.map((i) => `${i.row}:${i.code}`)).toEqual(["5:conflicting_duplicate", "9:missing_title", "10:negative_price", "11:missing_currency", "13:conflicting_duplicate"]);
    expect(v.counts).toEqual({ input: 14, accepted: 8, rejected: 5, collapsed: 1 });
    expect(conserved(v)).toBe(true);
    expect(v.conflicts).toEqual([expect.objectContaining({ sku: "PP-004", selectedRow: null })]);
    expect(v.accepted.map((r) => r.fields.sku)).not.toContain("PP-004");
  });
  it("accepts the selected row of a conflicting SKU and still conserves counts", () => {
    const v = validateCatalog(csv, map, { "PP-004": 5 });
    expect(v.counts).toEqual({ input: 14, accepted: 9, rejected: 4, collapsed: 1 });
    expect(conserved(v)).toBe(true);
    expect(v.accepted.find((r) => r.fields.sku === "PP-004")?.fields.title).toBe("Moisturizing Shampoo");
    expect(v.issues.find((i) => i.row === 13)?.code).toBe("duplicate_not_selected");
  });
  it("preserves source values and normalizes separately", () => {
    const v = validateCatalog(parseCsv('sku,title,price,currency\n A-1 ,"  Whole   Milk  ",4.5,usd\n'), { merchant_sku: "sku", title: "title", price: "price", currency: "currency" });
    expect(v.accepted[0].raw).toEqual({ sku: " A-1 ", title: "  Whole   Milk  ", price: "4.5", currency: "usd" });
    expect(v.accepted[0].fields).toMatchObject({ sku: "A-1", title: "Whole Milk", price: "4.5", currency: "USD" });
  });
  it("rejects invalid field types", () => {
    const v = validateCatalog(parseCsv("sku,title,price,currency,gtin\nA,One,$4,USD,\nB,Two,4,US,\nC,Three,,,12AB\nD,Four,1.23456,USD,\nE,Five,0,USD,12345678\n"), {
      merchant_sku: "sku",
      title: "title",
      price: "price",
      currency: "currency",
      gtin: "gtin",
    });
    expect(v.issues.map((i) => `${i.row}:${i.code}`)).toEqual(["2:invalid_price", "3:invalid_currency", "4:invalid_gtin", "5:invalid_price"]);
    expect(v.accepted.map((r) => r.fields.sku)).toEqual(["E"]);
  });
  it("treats a price-only change as the same classification content", () => {
    const base = { sku: "A", title: "Whole Milk", description: null, merchantCategoryPath: "Dairy", brand: null, gtin: null, packageSize: "1 gal", price: "4.00", currency: "USD" };
    expect(classificationHash({ ...base, price: "4.50" })).toBe(classificationHash(base));
    expect(classificationHash({ ...base, title: "whole  MILK" })).toBe(classificationHash(base));
    expect(classificationHash({ ...base, title: "Whole Milk New Formula" })).not.toBe(classificationHash(base));
  });
});
