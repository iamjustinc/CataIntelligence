import type { ParsedCsv } from "@/lib/csv";

export const TAXONOMY_COLUMNS = ["concept_id", "parent_id", "name", "definition", "synonyms", "status", "mapping_allowed"] as const;
export const MAX_DEPTH = 8;
export const MAX_CONCEPTS = 5000;

export interface TaxonomyIssue {
  /** Source row number (header is row 1); 0 for file-level issues. */
  row: number;
  conceptId: string | null;
  field: string | null;
  code: string;
  message: string;
}

export interface ConceptInput {
  row: number;
  stableKey: string;
  parentKey: string | null;
  name: string;
  definition: string;
  synonyms: string[];
  status: "active" | "inactive";
  mappingAllowed: boolean;
}

export interface ValidatedConcept extends ConceptInput {
  depth: number;
  /** Canonical path of names from the root, joined with " > ". */
  path: string;
}

export interface TaxonomyValidation {
  errors: TaxonomyIssue[];
  warnings: TaxonomyIssue[];
  /** Present only when there are no errors. */
  concepts: ValidatedConcept[];
  counts: { rows: number; concepts: number; leaves: number; mappable: number; maxDepth: number };
}

const TRUE = new Set(["true", "1", "yes", "y"]);
const FALSE = new Set(["false", "0", "no", "n", ""]);
export const normalizeTerm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** Maps CSV records to concept inputs, reporting cell-level problems. */
export function readTaxonomyCsv(csv: ParsedCsv): { inputs: ConceptInput[]; errors: TaxonomyIssue[] } {
  const errors: TaxonomyIssue[] = [];
  const index = new Map(csv.header.map((h, i) => [h.toLowerCase(), i]));
  const missing = TAXONOMY_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) {
    errors.push({ row: 0, conceptId: null, field: null, code: "missing_columns", message: `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.` });
    return { inputs: [], errors };
  }
  if (csv.records.length > MAX_CONCEPTS) {
    errors.push({ row: 0, conceptId: null, field: null, code: "too_many_rows", message: `A taxonomy may contain at most ${MAX_CONCEPTS} concepts; this file has ${csv.records.length}.` });
    return { inputs: [], errors };
  }
  const inputs: ConceptInput[] = [];
  for (const record of csv.records) {
    const get = (c: (typeof TAXONOMY_COLUMNS)[number]) => (record.cells[index.get(c)!] ?? "").trim();
    const stableKey = get("concept_id");
    const issue = (field: string, code: string, message: string) => errors.push({ row: record.row, conceptId: stableKey || null, field, code, message });
    if (!stableKey) issue("concept_id", "missing_id", "concept_id is required.");
    else if (stableKey.length > 100) issue("concept_id", "id_too_long", "concept_id must be at most 100 characters.");
    const name = get("name");
    if (!name) issue("name", "missing_name", "name is required.");
    const statusRaw = get("status").toLowerCase() || "active";
    if (statusRaw !== "active" && statusRaw !== "inactive") issue("status", "invalid_status", `status must be "active" or "inactive", not "${get("status")}".`);
    const allowedRaw = get("mapping_allowed").toLowerCase();
    if (!TRUE.has(allowedRaw) && !FALSE.has(allowedRaw)) issue("mapping_allowed", "invalid_boolean", `mapping_allowed must be true or false, not "${get("mapping_allowed")}".`);
    inputs.push({
      row: record.row,
      stableKey,
      parentKey: get("parent_id") || null,
      name,
      definition: get("definition"),
      // Synonyms are pipe-delimited; original punctuation and case are preserved.
      synonyms: [...new Set(get("synonyms").split("|").map((s) => s.trim()).filter(Boolean))],
      status: statusRaw === "inactive" ? "inactive" : "active",
      mappingAllowed: TRUE.has(allowedRaw),
    });
  }
  return { inputs, errors };
}

/**
 * Structural validation of a whole tree (PRD TAX01). Used for CSV imports and again, against the
 * stored rows, immediately before a version is published.
 */
export function validateTaxonomy(inputs: ConceptInput[], cellErrors: TaxonomyIssue[] = []): TaxonomyValidation {
  const errors = [...cellErrors];
  const warnings: TaxonomyIssue[] = [];
  const err = (c: ConceptInput, field: string | null, code: string, message: string) => errors.push({ row: c.row, conceptId: c.stableKey || null, field, code, message });
  const warn = (c: ConceptInput, field: string | null, code: string, message: string) => warnings.push({ row: c.row, conceptId: c.stableKey || null, field, code, message });

  const byKey = new Map<string, ConceptInput>();
  for (const c of inputs) {
    if (!c.stableKey) continue;
    const first = byKey.get(c.stableKey);
    if (first) err(c, "concept_id", "duplicate_id", `Duplicate concept_id "${c.stableKey}" (first used on row ${first.row}).`);
    else byKey.set(c.stableKey, c);
  }
  const unique = [...byKey.values()];

  const roots = unique.filter((c) => c.parentKey === null);
  if (unique.length > 0 && roots.length === 0) {
    errors.push({ row: 0, conceptId: null, field: "parent_id", code: "no_root", message: "No root concept: exactly one row must have an empty parent_id." });
  }
  for (const extra of roots.slice(1)) err(extra, "parent_id", "multiple_roots", `Multiple roots: "${extra.stableKey}" has no parent, but "${roots[0].stableKey}" (row ${roots[0].row}) is already the root.`);

  const children = new Map<string, ConceptInput[]>();
  for (const c of unique) {
    if (c.parentKey === null) continue;
    if (c.parentKey === c.stableKey) {
      err(c, "parent_id", "cycle", `"${c.stableKey}" is its own parent.`);
    } else if (!byKey.has(c.parentKey)) {
      err(c, "parent_id", "missing_parent", `parent_id "${c.parentKey}" does not exist in this file.`);
    } else {
      children.set(c.parentKey, [...(children.get(c.parentKey) ?? []), c]);
    }
  }

  // Depth by walking up; a walk that revisits a node is a cycle.
  const depth = new Map<string, number>();
  const inCycle = new Set<string>();
  for (const start of unique) {
    const trail: string[] = [];
    const seen = new Set<string>();
    let cur: ConceptInput | undefined = start;
    while (cur && !depth.has(cur.stableKey) && !inCycle.has(cur.stableKey)) {
      if (seen.has(cur.stableKey)) {
        for (const k of trail.slice(trail.indexOf(cur.stableKey))) inCycle.add(k);
        break;
      }
      seen.add(cur.stableKey);
      trail.push(cur.stableKey);
      cur = cur.parentKey && cur.parentKey !== cur.stableKey ? byKey.get(cur.parentKey) : undefined;
    }
    if (cur && inCycle.has(cur.stableKey)) continue; // members or descendants of a cycle have no depth
    let d = cur ? depth.get(cur.stableKey)! : 0;
    for (const key of trail.reverse()) {
      if (inCycle.has(key)) break;
      const node = byKey.get(key)!;
      // A node with a missing parent is not anchored to the root; skip depth for it.
      if (node.parentKey !== null && !byKey.has(node.parentKey)) break;
      d += 1;
      depth.set(key, d);
    }
  }
  for (const key of inCycle) {
    const c = byKey.get(key)!;
    if (c.parentKey !== c.stableKey) err(c, "parent_id", "cycle", `"${c.stableKey}" is part of a parent cycle.`);
  }
  for (const c of unique) {
    const d = depth.get(c.stableKey);
    if (d !== undefined && d > MAX_DEPTH) err(c, "parent_id", "too_deep", `"${c.stableKey}" is at depth ${d}; the maximum is ${MAX_DEPTH}.`);
  }

  for (const c of unique) {
    const hasChildren = (children.get(c.stableKey)?.length ?? 0) > 0;
    if (c.mappingAllowed && hasChildren) err(c, "mapping_allowed", "mapping_on_non_leaf", `"${c.stableKey}" has child concepts, so mapping_allowed must be false. Products map only to leaves.`);
    if (c.mappingAllowed && c.status !== "active") err(c, "mapping_allowed", "mapping_on_inactive", `"${c.stableKey}" is inactive, so mapping_allowed must be false.`);
    if (!hasChildren && c.status === "active" && !c.mappingAllowed) warn(c, "mapping_allowed", "leaf_not_mappable", `"${c.stableKey}" is an active leaf but cannot receive mappings.`);
    if (c.mappingAllowed && !c.definition) warn(c, "definition", "missing_definition", `"${c.stableKey}" accepts mappings but has no definition; reviewers and retrieval rely on definitions.`);
  }

  // A term that points at more than one concept can never be a unique exact-match signal.
  const terms = new Map<string, Set<string>>();
  for (const c of unique) {
    if (!c.mappingAllowed) continue;
    for (const t of [c.name, ...c.synonyms]) {
      const n = normalizeTerm(t);
      if (n) terms.set(n, (terms.get(n) ?? new Set()).add(c.stableKey));
    }
  }
  for (const c of unique) {
    for (const s of c.synonyms) {
      const owners = terms.get(normalizeTerm(s));
      if (c.mappingAllowed && owners && owners.size > 1) {
        warn(c, "synonyms", "ambiguous_synonym", `Synonym "${s}" is also used by ${[...owners].filter((k) => k !== c.stableKey).join(", ")}; it will not act as a unique match.`);
      }
    }
  }

  const leaves = unique.filter((c) => !(children.get(c.stableKey)?.length ?? 0)).length;
  const counts = {
    rows: inputs.length,
    concepts: unique.length,
    leaves,
    mappable: unique.filter((c) => c.mappingAllowed).length,
    maxDepth: Math.max(0, ...depth.values()),
  };
  const byRow = (a: TaxonomyIssue, b: TaxonomyIssue) => a.row - b.row;
  errors.sort(byRow);
  warnings.sort(byRow);
  if (errors.length > 0) return { errors, warnings, concepts: [], counts };

  const pathOf = (c: ConceptInput): string => (c.parentKey ? `${pathOf(byKey.get(c.parentKey)!)} > ${c.name}` : c.name);
  const concepts = unique.map((c) => ({ ...c, depth: depth.get(c.stableKey)!, path: pathOf(c) }));
  return { errors, warnings, concepts, counts };
}

/** Terms shared by more than one mappable concept in a validated tree. */
export function ambiguousTerms(concepts: ConceptInput[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const c of concepts) {
    if (!c.mappingAllowed) continue;
    for (const t of [c.name, ...c.synonyms]) owners.set(normalizeTerm(t), (owners.get(normalizeTerm(t)) ?? new Set()).add(c.stableKey));
  }
  return new Set([...owners].filter(([, set]) => set.size > 1).map(([term]) => term));
}
