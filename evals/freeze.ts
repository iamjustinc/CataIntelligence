/**
 * Freezes the independent test set (evals/PROTOCOL.md, step 6).
 *
 *   pnpm eval:freeze --author "<name>" --labelers "<A>,<B>" --adjudicator "<name>" --agreement-raw 0.91 --agreement-kappa 0.84
 *
 * Refuses unless evals/corpus/frozen.jsonl exists, every record is expert-labeled by two of the
 * named people and adjudicated (or recorded as a disagreement), and the set shares no product
 * family or near-duplicate title with the development data or the demo fixtures. Writes
 * frozen.manifest.json with the file's hash. It never creates or edits labels.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { frozenProblems, loadDataset, recordSchema, type FrozenManifest } from "./corpus";
import { checkCorpus } from "./leakage";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dir = resolve(process.cwd(), "evals/corpus");
const file = resolve(dir, "frozen.jsonl");
const fail = (message: string): never => {
  console.error(`Not frozen: ${message}`);
  process.exit(1);
};

if (!existsSync(file)) fail("evals/corpus/frozen.jsonl does not exist. It must be written and labeled by independent experts (evals/PROTOCOL.md).");
if (existsSync(resolve(dir, "frozen.manifest.json"))) fail("a manifest already exists. A frozen set is immutable; a changed set is a new version in a new file.");
const [author, labelers, adjudicator, raw, kappa] = [arg("author"), arg("labelers")?.split(",").map((s) => s.trim()).filter(Boolean), arg("adjudicator"), Number(arg("agreement-raw")), Number(arg("agreement-kappa"))];
if (!author || !labelers || labelers.length < 2 || !adjudicator || Number.isNaN(raw) || Number.isNaN(kappa)) fail("--author, --labelers (two names), --adjudicator, --agreement-raw and --agreement-kappa are required.");

const text = readFileSync(file, "utf8");
const records = text.split("\n").filter((l) => l.trim()).map((line, i) => {
  const parsed = recordSchema.safeParse(JSON.parse(line));
  if (!parsed.success || parsed.data.split !== "frozen") return fail(`line ${i + 1} is not a valid frozen record.`);
  return parsed.data;
});
const manifest: FrozenManifest = { sha256: createHash("sha256").update(text).digest("hex"), records: records.length, frozenAt: new Date().toISOString(), author: author!, labelers: labelers!, adjudicator: adjudicator!, agreement: { raw, kappa }, inspected: null, scoredRuns: 0 };
const problems = frozenProblems(text, records, manifest);
// The frozen set must be new to everything that was ever tuned against or shown in the demo.
const tuned = [...loadDataset("development").records, ...loadDataset("heldout").records];
problems.push(...checkCorpus(tuned, records).problems);
if (records.length < 200) problems.push(`The set has ${records.length} records; the protocol asks for at least 200.`);
if (problems.length) fail(`\n${problems.map((p) => `- ${p}`).join("\n")}`);
writeFileSync(resolve(dir, "frozen.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Frozen ${records.length} records. sha256 ${manifest.sha256}. Commit frozen.jsonl and frozen.manifest.json together.`);
