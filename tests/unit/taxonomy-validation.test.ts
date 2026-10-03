import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CsvError, decodeUtf8, parseCsv } from "@/lib/csv";
import { readTaxonomyCsv, validateTaxonomy } from "@/lib/domain/taxonomy-validation";

const HEADER = "concept_id,parent_id,name,definition,synonyms,status,mapping_allowed";
const validate = (body: string) => {
  const { inputs, errors } = readTaxonomyCsv(parseCsv(`${HEADER}\n${body}`));
  return validateTaxonomy(inputs, errors);
};
const codes = (v: ReturnType<typeof validate>) => v.errors.map((e) => `${e.row}:${e.code}`);

describe("CSV parser", () => {
  it("handles quotes, doubled quotes, embedded newlines, CRLF and a BOM", () => {
    const csv = parseCsv('﻿a,b\r\n"x, ""y""","line1\nline2"\r\n\r\nlast,row\r\n');
    expect(csv.header).toEqual(["a", "b"]);
    expect(csv.records).toEqual([
      { row: 2, cells: ['x, "y"', "line1\nline2"] },
      { row: 4, cells: ["last", "row"] },
    ]);
  });
  it("rejects empty files, unterminated quotes and invalid UTF-8", () => {
    expect(() => parseCsv("")).toThrow(CsvError);
    expect(() => parseCsv('a,b\n"open,1')).toThrow(/never closed/);
    expect(() => decodeUtf8(new Uint8Array([0xff, 0xfe, 0x41]))).toThrow(/UTF-8/);
  });
});

describe("taxonomy validation (TAX01, AT04)", () => {
  it("accepts the generated fixture taxonomy and computes paths", () => {
    const text = readFileSync(new URL("../../fixtures/generated/taxonomy.csv", import.meta.url), "utf8");
    const { inputs, errors } = readTaxonomyCsv(parseCsv(text));
    const v = validateTaxonomy(inputs, errors);
    expect(v.errors).toEqual([]);
    expect(v.counts).toMatchObject({ concepts: 153, mappable: 106, maxDepth: 4 });
    expect(v.concepts.find((c) => c.stableKey === "GRO-DAI-PLANT")?.path).toBe("All Products > Grocery > Dairy & Eggs > Plant-Based Milk");
  });
  it("reports missing columns before anything else", () => {
    const { errors } = readTaxonomyCsv(parseCsv("concept_id,name\nA,Alpha"));
    expect(errors[0].code).toBe("missing_columns");
    expect(errors[0].message).toContain("parent_id");
  });
  it("blocks duplicate IDs with the row of first use", () => {
    const v = validate("R,,Root,,,active,false\nA,R,Alpha,,,active,true\nA,R,Again,,,active,true");
    expect(codes(v)).toContain("4:duplicate_id");
    expect(v.errors.find((e) => e.code === "duplicate_id")?.message).toContain("row 3");
  });
  it("blocks missing parents", () => {
    expect(codes(validate("R,,Root,,,active,false\nA,NOPE,Alpha,,,active,true"))).toEqual(["3:missing_parent"]);
  });
  it("blocks cycles, including self-parenting", () => {
    const v = validate("R,,Root,,,active,false\nA,B,Alpha,,,active,false\nB,C,Beta,,,active,false\nC,A,Gamma,,,active,false\nD,C,Delta,,,active,true\nS,S,Self,,,active,true");
    expect(codes(v).sort()).toEqual(["3:cycle", "4:cycle", "5:cycle", "7:cycle"]);
  });
  it("blocks multiple roots and a file with no root", () => {
    expect(codes(validate("R,,Root,,,active,false\nR2,,Second,,,active,false"))).toEqual(["3:multiple_roots"]);
    expect(codes(validate("A,B,Alpha,,,active,false\nB,A,Beta,,,active,false"))).toContain("0:no_root");
  });
  it("blocks depth beyond eight levels", () => {
    const chain = Array.from({ length: 9 }, (_, i) => `N${i + 1},${i === 0 ? "" : `N${i}`},Level ${i + 1},,,active,${i === 8}`).join("\n");
    expect(codes(validate(chain))).toEqual(["10:too_deep"]);
    const ok = Array.from({ length: 8 }, (_, i) => `N${i + 1},${i === 0 ? "" : `N${i}`},Level ${i + 1},,,active,${i === 7}`).join("\n");
    expect(validate(ok).errors).toEqual([]);
  });
  it("blocks mapping on non-leaves and on inactive concepts", () => {
    const v = validate("R,,Root,,,active,true\nA,R,Alpha,,,inactive,true");
    expect(codes(v).sort()).toEqual(["2:mapping_on_non_leaf", "3:mapping_on_inactive"]);
  });
  it("blocks invalid cell values with row and field", () => {
    const v = validate("R,,Root,,,active,false\n,R,NoId,,,active,true\nB,R,,,,retired,maybe");
    expect(v.errors.map((e) => `${e.row}:${e.field}:${e.code}`).sort()).toEqual(["3:concept_id:missing_id", "4:mapping_allowed:invalid_boolean", "4:name:missing_name", "4:status:invalid_status"]);
  });
  it("permits duplicate names under different parents and warns on ambiguous synonyms", () => {
    const v = validate(
      "R,,Root,,,active,false\nP1,R,Food,,,active,false\nP2,R,Pet,,,active,false\nA,P1,Treats,Human treats,snacks|goodies,active,true\nB,P2,Treats,Pet treats,goodies,active,true",
    );
    expect(v.errors).toEqual([]);
    expect(v.warnings.filter((w) => w.code === "ambiguous_synonym").map((w) => w.conceptId).sort()).toEqual(["A", "B"]);
    expect(v.concepts.find((c) => c.stableKey === "B")?.path).toBe("Root > Pet > Treats");
  });
});
