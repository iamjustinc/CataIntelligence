/**
 * Leakage and composition checks for the evaluation corpus. Run with `pnpm eval:check`.
 * A failing check means held-out results could be inflated and must not be reported.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { tokenize } from "@/lib/retrieval/candidates";
import { demoTitles, evaluationTaxonomy, loadDataset, type EvalRecord } from "./corpus";

export const NEAR_DUPLICATE_THRESHOLD = 0.8;

const tokens = (title: string) => new Set(tokenize(title).map((t) => t.norm));
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface LeakageReport {
  problems: string[];
  composition: Record<string, number | string[]>;
}

export function checkCorpus(development: EvalRecord[], heldout: EvalRecord[], demo = demoTitles()): LeakageReport {
  const problems: string[] = [];
  const all = [...development, ...heldout];
  const { leafKeys } = evaluationTaxonomy();

  const ids = new Set<string>();
  for (const r of all) {
    if (ids.has(r.id)) problems.push(`Duplicate record id ${r.id}.`);
    ids.add(r.id);
    for (const key of [r.label.conceptKey, ...r.label.acceptable]) if (key && !leafKeys.has(key)) problems.push(`${r.id}: label "${key}" is not a mappable leaf of the evaluation taxonomy.`);
    if (r.label.missingConcept && r.label.conceptKey) problems.push(`${r.id}: a missing-concept record cannot also name a correct leaf.`);
    if (r.label.conceptKey && r.label.acceptable.includes(r.label.conceptKey)) problems.push(`${r.id}: the correct leaf is repeated in acceptable.`);
  }

  // 1. A product family belongs to exactly one split.
  const devFamilies = new Set(development.map((r) => r.family));
  for (const r of heldout) if (devFamilies.has(r.family)) problems.push(`Family "${r.family}" appears in both development and held-out.`);

  // 2. No duplicate or near-duplicate titles across splits, or between an evaluation set and the demo fixtures.
  const tokenized = (rs: { id: string; title: string }[]) => rs.map((r) => ({ id: r.id, title: r.title, set: tokens(r.title) }));
  const dev = tokenized(development);
  const held = tokenized(heldout);
  const fixtures = tokenized(demo);
  const compare = (a: typeof dev, b: typeof dev, what: string) => {
    for (const x of a) {
      for (const y of b) {
        const j = jaccard(x.set, y.set);
        if (j >= NEAR_DUPLICATE_THRESHOLD) problems.push(`${what}: "${x.title}" (${x.id}) and "${y.title}" (${y.id}) are ${j === 1 ? "duplicates" : `near-duplicates (${j.toFixed(2)})`}.`);
      }
    }
  };
  compare(held, dev, "held-out vs development");
  compare(held, fixtures, "held-out vs demo fixtures");
  compare(dev, fixtures, "development vs demo fixtures");

  // 3. Held-out contains at least one merchant the development set never saw.
  const devMerchants = new Set(development.map((r) => r.merchant));
  const unseen = [...new Set(heldout.map((r) => r.merchant))].filter((m) => !devMerchants.has(m));
  if (unseen.length === 0) problems.push("Held-out has no merchant that is absent from development.");

  const count = (rs: EvalRecord[], f: (r: EvalRecord) => boolean) => rs.filter(f).length;
  const composition = {
    total: all.length,
    development: development.length,
    heldout: heldout.length,
    merchants: [...new Set(all.map((r) => r.merchant))].sort(),
    heldoutOnlyMerchants: unseen,
    domains: new Set(all.map((r) => r.domain)).size,
    ambiguous: count(all, (r) => r.label.issues.includes("ambiguous")),
    missingConcept: count(all, (r) => r.label.missingConcept),
    adversarial: count(all, (r) => r.label.issues.includes("injection")),
    sparse: count(all, (r) => r.label.issues.includes("sparse")),
    misleadingCategory: count(all, (r) => r.label.issues.includes("misleading_category")),
    expertLabeled: count(all, (r) => r.labeling.source === "expert"),
    adjudicated: count(all, (r) => r.labeling.adjudicated),
  };
  // PRD 13.5 minimums.
  if (composition.total < 200) problems.push(`Corpus has ${composition.total} records; at least 200 are required.`);
  if (composition.heldout < 100) problems.push(`Held-out has ${composition.heldout} records; at least 100 are required.`);
  if (composition.merchants.length < 3) problems.push("At least three merchants are required.");
  if (composition.domains < 8) problems.push("All eight top-level domains are required.");
  if (composition.ambiguous < 30) problems.push(`Only ${composition.ambiguous} ambiguous records; at least 30 are required.`);
  if (composition.missingConcept < 20) problems.push(`Only ${composition.missingConcept} missing-concept records; at least 20 are required.`);
  return { problems, composition };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkCorpus(loadDataset("development").records, loadDataset("heldout").records);
  console.log(JSON.stringify(report.composition, null, 2));
  if (report.problems.length > 0) {
    console.error(`\n${report.problems.length} problem(s):\n- ${report.problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nNo leakage or composition problems found.");
  if (report.composition.expertLabeled === 0) console.log("Note: no record is expert-labeled. Results on this corpus are preliminary.");
}
