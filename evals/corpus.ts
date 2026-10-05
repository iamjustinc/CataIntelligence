/**
 * Evaluation corpus format and loaders (PRD 13.5).
 *
 * Three datasets are kept apart:
 *   development  evals/corpus/development.jsonl   for tuning retrieval, prompts and policies
 *   heldout      evals/corpus/heldout.jsonl       scored only to report results, never tuned against.
 *                                                 INSPECTED: see HELDOUT_STATUS below
 *   frozen       evals/corpus/frozen.jsonl        expert-labeled, hash-pinned by frozen.manifest.json,
 *                                                 reported in aggregate only. NOT AUTHORED YET.
 *                                                 See evals/PROTOCOL.md
 *   demo         fixtures/generated/*             what the demo provider answers for; not an evaluation set
 *
 * Every record carries who labeled it. Records labeled `provisional_model_authored` are NOT expert
 * ground truth: results on them are preliminary and can never satisfy a launch gate.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { buildFixtures, parseTaxonomy } from "@/fixtures/generate";
import type { RetrievalConcept } from "@/lib/retrieval/candidates";

/**
 * The held-out set is no longer untouched. Its baseline run was scored and its individual misses
 * were printed and read on 2026-10-04 while building the harness. Nothing was tuned against it,
 * but results on it must be reported as "inspected held-out", it cannot open the High gate, and
 * retrieval or prompt work must use the development set only. The next independent assessment
 * needs the frozen set described in evals/PROTOCOL.md, written and labeled by people other than
 * this application's author. The inspected set is development data from now on.
 */
export const HELDOUT_STATUS = { inspected: true, since: "2026-10-04", reason: "Baseline misses on this set were printed and read during harness development." } as const;

export const ISSUES = ["ambiguous", "sparse", "misleading_category", "injection", "attribute_trap", "missing_concept", "overlapping_label"] as const;

export const recordSchema = z.strictObject({
  id: z.string().min(1),
  split: z.enum(["development", "heldout", "frozen"]),
  merchant: z.string().min(1),
  /** Product family. A family may appear in one split only, so near-variants cannot leak. */
  family: z.string().min(1),
  domain: z.enum(["grocery", "beverages", "household", "personal_care", "otc_health", "pet", "baby", "general_merchandise"]),
  title: z.string().min(1),
  description: z.string().nullable(),
  merchantCategoryPath: z.string().nullable(),
  brand: z.string().nullable(),
  packageSize: z.string().nullable(),
  label: z.strictObject({
    /** Stable key of the correct leaf, or null when the correct outcome is abstention. */
    conceptKey: z.string().nullable(),
    /** Other leaves a careful reviewer could defend. Used for lenient scoring only. */
    acceptable: z.array(z.string()),
    /** True when abstention is correct because the taxonomy lacks a suitable concept. */
    missingConcept: z.boolean(),
    issues: z.array(z.enum(ISSUES)),
    difficulty: z.enum(["easy", "medium", "hard"]),
  }),
  labeling: z.strictObject({
    source: z.enum(["provisional_model_authored", "expert"]),
    labelers: z.array(z.string()).min(1),
    /** A second reviewer has adjudicated this record. */
    adjudicated: z.boolean(),
    /** Recorded rather than forced to a single truth (PRD 13.5). */
    disagreement: z.strictObject({ alternatives: z.array(z.string().nullable()), note: z.string() }).nullable(),
  }),
});
export type EvalRecord = z.infer<typeof recordSchema>;
export type Split = "development" | "heldout" | "frozen";
/** Sets that may be tuned against and read record by record. The former held-out set is one of them. */
export const DEVELOPMENT_SPLITS: readonly Split[] = ["development", "heldout"];

/** Written by `pnpm eval:freeze`. The frozen file is valid only while its hash matches this record. */
export const frozenManifestSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  records: z.number().int().positive(),
  frozenAt: z.iso.datetime(),
  author: z.string().min(1),
  labelers: z.array(z.string().min(1)).min(2),
  adjudicator: z.string().min(1),
  /** Agreement between the two labelers before adjudication. */
  agreement: z.strictObject({ raw: z.number().min(0).max(1), kappa: z.number().min(-1).max(1) }),
  /** Set once anyone reads per-record results or tunes against this set. It then becomes development data. */
  inspected: z.strictObject({ at: z.iso.datetime(), reason: z.string().min(1) }).nullable(),
  /** Scored runs so far. The protocol retires a set after five. */
  scoredRuns: z.number().int().min(0),
});
export type FrozenManifest = z.infer<typeof frozenManifestSchema>;
export const MAX_FROZEN_RUNS = 5;

/** Problems that make a frozen set unusable. Empty when it may be scored. */
export function frozenProblems(text: string, records: EvalRecord[], manifest: FrozenManifest | null): string[] {
  if (!manifest) return ["frozen.manifest.json is missing: the set has not been frozen (pnpm eval:freeze)."];
  const problems: string[] = [];
  if (createHash("sha256").update(text).digest("hex") !== manifest.sha256) problems.push("frozen.jsonl does not match the hash in its manifest: it was changed after freezing.");
  if (records.length !== manifest.records) problems.push(`The manifest records ${manifest.records} records; the file has ${records.length}.`);
  const provisional = records.filter((r) => r.labeling.source !== "expert").length;
  if (provisional) problems.push(`${provisional} records are not expert-labeled.`);
  const single = records.filter((r) => new Set(r.labeling.labelers).size < 2).length;
  if (single) problems.push(`${single} records were not labeled by two people.`);
  const unresolved = records.filter((r) => !r.labeling.adjudicated && !r.labeling.disagreement).length;
  if (unresolved) problems.push(`${unresolved} records are neither adjudicated nor recorded as a disagreement.`);
  const outsiders = records.filter((r) => r.labeling.labelers.some((l) => !manifest.labelers.includes(l) && l !== manifest.adjudicator)).length;
  if (outsiders) problems.push(`${outsiders} records name a labeler who is not in the manifest.`);
  if (manifest.inspected) problems.push(`This set was inspected on ${manifest.inspected.at} (${manifest.inspected.reason}). It is development data now; build a new frozen set.`);
  if (manifest.scoredRuns >= MAX_FROZEN_RUNS) problems.push(`This set has been scored ${manifest.scoredRuns} times. The protocol retires a set after ${MAX_FROZEN_RUNS}.`);
  return problems;
}

const root = (...p: string[]) => resolve(process.cwd(), ...p);

export interface Dataset {
  split: Split;
  records: EvalRecord[];
  /** sha256 of the file: the dataset version quoted in every report. */
  version: string;
  labeling: { expert: number; provisional: number; adjudicated: number };
}

export function readManifest(dir = root("evals/corpus")): FrozenManifest | null {
  const path = resolve(dir, "frozen.manifest.json");
  if (!existsSync(path)) return null;
  const parsed = frozenManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`frozen.manifest.json is invalid: ${parsed.error.issues[0].path.join(".")} ${parsed.error.issues[0].message}`);
  return parsed.data;
}

/**
 * Loads one split. The frozen split loads only when it exists, matches its manifest and is fully
 * expert-labeled; any other state is an error, never a silent fall back to another set.
 */
export function loadDataset(split: Split, dir = root("evals/corpus")): Dataset {
  const file = resolve(dir, `${split}.jsonl`);
  if (split === "frozen" && !existsSync(file)) throw new Error("No frozen test set exists yet. It must be written and labeled by independent experts: see evals/PROTOCOL.md. Nothing was run.");
  const text = readFileSync(file, "utf8");
  const records = text
    .split("\n")
    .filter((l) => l.trim())
    .map((line, i) => {
      const parsed = recordSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`${split}.jsonl line ${i + 1}: ${parsed.error.issues[0].path.join(".")} ${parsed.error.issues[0].message}`);
      if (parsed.data.split !== split) throw new Error(`${split}.jsonl line ${i + 1}: record belongs to split "${parsed.data.split}"`);
      return parsed.data;
    });
  if (split === "frozen") {
    const problems = frozenProblems(text, records, readManifest(dir));
    if (problems.length) throw new Error(`The frozen test set cannot be used:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
  return {
    split,
    records,
    version: createHash("sha256").update(text).digest("hex").slice(0, 16),
    labeling: { expert: records.filter((r) => r.labeling.source === "expert").length, provisional: records.filter((r) => r.labeling.source !== "expert").length, adjudicated: records.filter((r) => r.labeling.adjudicated).length },
  };
}

/** Titles of the demo fixtures, for leakage checks against the evaluation sets. */
export function demoTitles(): { id: string; title: string }[] {
  const fx = buildFixtures();
  return Object.entries(fx.catalogs).flatMap(([catalog, rows]) => rows.map((r) => ({ id: `${catalog}:${r.sku}`, title: r.title })));
}

/** The fixture taxonomy as retrieval concepts, with deterministic IDs so no database is needed. */
export function evaluationTaxonomy() {
  const concepts = parseTaxonomy();
  const keys = concepts.map((c) => c.key);
  const idOf = (key: string) => `00000000-0000-4000-8000-${String(keys.indexOf(key)).padStart(12, "0")}`;
  const byKey = new Map(concepts.map((c) => [c.key, c]));
  const pathOf = (key: string): string => {
    const c = byKey.get(key)!;
    return c.parentKey ? `${pathOf(c.parentKey)} > ${c.name}` : c.name;
  };
  const leaves: RetrievalConcept[] = concepts.filter((c) => c.products.length > 0).map((c) => ({ conceptId: idOf(c.key), stableKey: c.key, parentConceptId: c.parentKey ? idOf(c.parentKey) : null, name: c.name, definition: c.definition, synonyms: c.synonyms, path: pathOf(c.key) }));
  const branches = concepts.filter((c) => c.products.length === 0).map((c) => ({ conceptId: idOf(c.key), stableKey: c.key, path: pathOf(c.key) }));
  return { leaves, branches, leafKeys: new Set(leaves.map((l) => l.stableKey)), keyOfId: new Map(leaves.map((l) => [l.conceptId, l.stableKey])) };
}
