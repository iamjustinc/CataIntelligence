/**
 * Deterministic fixture generator. Reads the curated sources and writes:
 *   fixtures/generated/taxonomy.csv
 *   fixtures/generated/catalogs/*.csv
 *   fixtures/generated/expected.json   (curated expected concept per SKU, for demo mode and tests)
 * No randomness and no timestamps: running it twice produces byte-identical files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SPECIAL_CASES } from "./source/special-cases";
import { TAXONOMY_SOURCE } from "./source/taxonomy";

export interface ConceptSeed {
  key: string;
  parentKey: string | null;
  name: string;
  definition: string;
  synonyms: string[];
  depth: number;
  products: ProductSeed[];
}
export interface ProductSeed {
  title: string;
  brand: string;
  size: string;
  price: string;
  description: string;
}
export interface CatalogRow {
  sku: string;
  title: string;
  description: string;
  category: string;
  brand: string;
  gtin: string;
  size: string;
  price: string;
  currency: string;
}
export interface Expected {
  expected: string | null;
  acceptable: string[];
  kind: string;
  note: string;
}

export const MERCHANTS = [
  { slug: "harbor-market", name: "Harbor Market", externalKey: "HARBOR", region: "US-West", prefix: "HM" },
  { slug: "daily-basket", name: "Daily Basket", externalKey: "DAILY", region: "US-East", prefix: "DB" },
  { slug: "corner-goods", name: "Corner Goods", externalKey: "CORNER", region: "US-Central", prefix: "CG" },
] as const;
type MerchantSlug = (typeof MERCHANTS)[number]["slug"];

export const TOTAL_LISTINGS = 300;

export function parseTaxonomy(source = TAXONOMY_SOURCE): ConceptSeed[] {
  const concepts: ConceptSeed[] = [];
  const stack: ConceptSeed[] = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    const depth = (line.length - line.trimStart().length) / 2 + 1;
    const [head, productPart] = line.trim().split(" || ");
    const [key, name, definition, synonyms] = head.split(" | ").map((s) => s.trim());
    const products = (productPart ?? "")
      .split(" ;; ")
      .filter((p) => p.trim())
      .map((p) => {
        const [title, brand = "", size = "", price = "", description = ""] = p.split(" ~ ").map((s) => s.trim());
        return { title, brand, size, price, description };
      });
    stack.length = depth - 1;
    const concept: ConceptSeed = {
      key,
      parentKey: stack[depth - 2]?.key ?? null,
      name,
      definition,
      synonyms: synonyms ? synonyms.split(";").map((s) => s.trim()) : [],
      depth,
      products,
    };
    stack.push(concept);
    concepts.push(concept);
  }
  return concepts;
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
export const toCsv = (header: string[], rows: string[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

/** Deterministic 13-digit code. Synthetic: uses the 200-299 restricted-circulation prefix. */
function syntheticGtin(n: number): string {
  const body = `29${String(n).padStart(10, "0")}`;
  const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return body + String((10 - (sum % 10)) % 10);
}

const COARSE: Record<string, string> = { GRO: "Food", BEV: "Drinks", HOU: "Essentials", GM: "Essentials", PET: "Essentials", PC: "Health & Beauty", OTC: "Health & Beauty", BABY: "Health & Beauty" };

function styleRow(merchant: MerchantSlug, sku: string, p: ProductSeed, ancestors: ConceptSeed[], n: number): CatalogRow {
  const [domain, mid, leaf] = [ancestors[1], ancestors[2], ancestors[ancestors.length - 1]];
  const base = { sku, gtin: syntheticGtin(n), size: p.size, price: p.price, currency: "USD", brand: p.brand };
  if (merchant === "harbor-market") {
    return { ...base, title: [p.brand, p.title].filter(Boolean).join(" "), description: p.description, category: [domain.name, mid.name, leaf.name].join(" > ") };
  }
  if (merchant === "daily-basket") {
    return { ...base, title: p.brand ? `${p.title} - ${p.brand} (${p.size})` : `${p.title} (${p.size})`, description: p.description, category: `${mid.name}/${leaf.name}` };
  }
  // Corner Goods: terse titles, no descriptions, coarse categories shared by unrelated products.
  return { ...base, gtin: "", brand: "", title: `${p.title} ${p.size}`.replace(/ fl oz/g, "oz").replace(/ ct/g, "ct"), description: "", category: COARSE[domain.key] };
}

export interface Fixtures {
  concepts: ConceptSeed[];
  catalogs: Record<string, CatalogRow[]>;
  expected: Record<string, Record<string, Expected>>;
}

export function buildFixtures(): Fixtures {
  const concepts = parseTaxonomy();
  const byKey = new Map(concepts.map((c) => [c.key, c]));
  const ancestorsOf = (c: ConceptSeed) => {
    const chain: ConceptSeed[] = [];
    for (let cur: ConceptSeed | undefined = c; cur; cur = cur.parentKey ? byKey.get(cur.parentKey) : undefined) chain.unshift(cur);
    return chain;
  };

  const catalogs: Record<string, CatalogRow[]> = { "harbor-market": [], "daily-basket": [], "corner-goods": [] };
  const expected: Record<string, Record<string, Expected>> = { "harbor-market": {}, "daily-basket": {}, "corner-goods": {} };
  const products = concepts.flatMap((c) => c.products.map((p) => ({ concept: c, product: p })));
  const regularTarget = TOTAL_LISTINGS - SPECIAL_CASES.length;
  if (products.length > regularTarget) throw new Error(`Too many product seeds (${products.length}) for ${TOTAL_LISTINGS} listings.`);

  // Each product goes to one merchant in rotation; the remainder is filled by listing early
  // products at a second merchant too (separate listings: the MVP never merges across merchants).
  const assignments = products.map((entry, i) => ({ ...entry, merchant: MERCHANTS[i % 3] }));
  for (let i = 0; assignments.length < regularTarget; i += 2) {
    assignments.push({ ...products[i], merchant: MERCHANTS[(i + 1) % 3] });
  }
  const counters: Record<string, number> = {};
  assignments.forEach(({ concept, product, merchant }, n) => {
    counters[merchant.slug] = (counters[merchant.slug] ?? 0) + 1;
    const sku = `${merchant.prefix}-${String(10000 + counters[merchant.slug])}`;
    catalogs[merchant.slug].push(styleRow(merchant.slug, sku, product, ancestorsOf(concept), n + 1));
    expected[merchant.slug][sku] = { expected: concept.key, acceptable: [], kind: "straightforward", note: "" };
  });
  for (const s of SPECIAL_CASES) {
    if (s.expected && !byKey.get(s.expected)?.products.length) throw new Error(`Special case ${s.sku} expects unknown leaf ${s.expected}`);
    catalogs[s.merchant].push({ sku: s.sku, title: s.title, description: s.description ?? "", category: s.category ?? "", brand: s.brand ?? "", gtin: "", size: s.size ?? "", price: s.price ?? "", currency: s.price ? "USD" : "" });
    expected[s.merchant][s.sku] = { expected: s.expected, acceptable: s.acceptable ?? [], kind: s.kind, note: s.note };
  }

  // Harbor Market revision 2 (snapshot): removals, classification-relevant edits, price-only edits, additions.
  const r1 = catalogs["harbor-market"];
  const r2 = r1.filter((_, i) => ![3, 17, 41, 58, 77].includes(i)).map((row, i) => {
    if ([5, 20, 35].includes(i)) return { ...row, title: `${row.title} New Formula`, description: `${row.description} Reformulated.`.trim() };
    if ([8, 26, 44, 62].includes(i)) return { ...row, price: (Number(row.price) + 0.5).toFixed(2) };
    return row;
  });
  const additions: [string, ProductSeed, string][] = [
    ["GRO-DAI-PLANT", { title: "Oat Milk Chocolate", brand: "Brightleaf", size: "32 fl oz", price: "4.79", description: "Chocolate oat beverage." }, "HM-20001"],
    ["BEV-WATER-SPARK", { title: "Grapefruit Sparkling Water 8 Pack", brand: "Nimbus", size: "8 x 12 fl oz", price: "3.99", description: "" }, "HM-20002"],
    ["HOU-CLEAN-SURF", { title: "Bathroom Cleaner Foam", brand: "Glint", size: "20 oz", price: "4.29", description: "" }, "HM-20003"],
    ["PET-CAT-TREAT", { title: "Catnip Bag", brand: "Whiskerly", size: "1 oz", price: "3.49", description: "Dried catnip for cats." }, "HM-20004"],
    ["GM-ELEC-BATT", { title: "9V Alkaline Battery 2 Pack", brand: "Voltcell", size: "2 ct", price: "8.49", description: "" }, "HM-20005"],
  ];
  expected["harbor-market-r2"] = Object.fromEntries(r2.map((row) => [row.sku, expected["harbor-market"][row.sku]]));
  additions.forEach(([key, product, sku], i) => {
    r2.push(styleRow("harbor-market", sku, product, ancestorsOf(byKey.get(key)!), 900 + i));
    expected["harbor-market-r2"][sku] = { expected: key, acceptable: [], kind: "straightforward", note: "" };
  });
  catalogs["harbor-market-r2"] = r2;

  return { concepts, catalogs, expected };
}

export const TAXONOMY_HEADER = ["concept_id", "parent_id", "name", "definition", "synonyms", "status", "mapping_allowed"];
export const CATALOG_HEADER = ["merchant_sku", "title", "description", "merchant_category_path", "brand", "gtin", "package_size", "price", "currency"];

export function taxonomyCsv(concepts: ConceptSeed[]): string {
  return toCsv(
    TAXONOMY_HEADER,
    concepts.map((c) => [c.key, c.parentKey ?? "", c.name, c.definition, c.synonyms.join("|"), "active", c.products.length > 0 ? "true" : "false"]),
  );
}
export function catalogCsv(rows: CatalogRow[]): string {
  return toCsv(CATALOG_HEADER, rows.map((r) => [r.sku, r.title, r.description, r.category, r.brand, r.gtin, r.size, r.price, r.currency]));
}

/**
 * Small import used in the guided walkthrough for a new merchant. Header names differ from the
 * canonical ones (column mapping) and it includes invalid rows, an exact duplicate, a conflicting
 * duplicate and a formula-leading cell.
 */
export const WALKTHROUGH_CSV = `Item Code,Product Name,Details,Dept,Maker,Pack,Retail,Cur
PP-001,Whole Milk Gallon,Grade A whole milk,Fridge > Milk,Meadow Lane,1 gal,4.19,USD
PP-002,Bananas,,Produce,,per lb,0.55,USD
PP-003,Lemon Dish Soap,Liquid for hand washing dishes,Cleaning,Glint,24 fl oz,2.89,USD
PP-004,Moisturizing Shampoo,Daily shampoo,Beauty,Purely,12 fl oz,4.79,USD
PP-005,Coconut Milk Shampoo,Shampoo with coconut milk extract,Fridge > Milk,Purely,13 fl oz,6.29,USD
PP-006,Apple,,Misc,,,1.19,USD
PP-007,Ginger Kombucha,Fermented sparkling tea drink,Drinks,Stillwater Tea,16 fl oz,3.39,USD
PP-008,,Missing title row,Pantry,,,1.00,USD
PP-009,Spaghetti,,Pantry,Nonna Vera,16 oz,-1.50,USD
PP-010,Black Beans,,Pantry,Goldfield,15 oz,0.95,
PP-003,Lemon Dish Soap,Liquid for hand washing dishes,Cleaning,Glint,24 fl oz,2.89,USD
PP-004,Clarifying Shampoo,Different product with a reused code,Beauty,Purely,12 fl oz,4.79,USD
PP-011,=SUM(A1:A9) Paper Towels,,Paper,Lumo,6 ct,8.79,USD
PP-012,Dry Dog Food Chicken,Complete food for adult dogs,Pets,Tailwag,15 lb,23.99,USD
`;

function main() {
  const out = resolve(dirname(fileURLToPath(import.meta.url)), "generated");
  mkdirSync(resolve(out, "catalogs"), { recursive: true });
  const { concepts, catalogs, expected } = buildFixtures();
  writeFileSync(resolve(out, "taxonomy.csv"), taxonomyCsv(concepts));
  writeFileSync(resolve(out, "catalogs/harbor-market-r1.csv"), catalogCsv(catalogs["harbor-market"]));
  writeFileSync(resolve(out, "catalogs/harbor-market-r2.csv"), catalogCsv(catalogs["harbor-market-r2"]));
  writeFileSync(resolve(out, "catalogs/daily-basket-r1.csv"), catalogCsv(catalogs["daily-basket"]));
  writeFileSync(resolve(out, "catalogs/corner-goods-r1.csv"), catalogCsv(catalogs["corner-goods"]));
  writeFileSync(resolve(out, "catalogs/walkthrough-pier-pantry.csv"), WALKTHROUGH_CSV);
  writeFileSync(resolve(out, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
  const leaves = concepts.filter((c) => c.products.length > 0).length;
  const total = catalogs["harbor-market"].length + catalogs["daily-basket"].length + catalogs["corner-goods"].length;
  console.log(`taxonomy: ${concepts.length} concepts (${leaves} leaves)`);
  console.log(`listings: ${total} across 3 merchants (harbor ${catalogs["harbor-market"].length}, daily ${catalogs["daily-basket"].length}, corner ${catalogs["corner-goods"].length}); harbor r2: ${catalogs["harbor-market-r2"].length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
