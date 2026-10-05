/**
 * Evaluation runner.
 *
 *   pnpm eval --split development --provider baseline
 *   pnpm eval --split heldout --provider claude --max-items 40     (needs ANTHROPIC_API_KEY and AI_MODEL_ID; spends real money)
 *
 * Providers:
 *   baseline  deterministic: selects the top retrieved candidate only when it is the single exact
 *             name or synonym match, otherwise abstains. It is a lexical yardstick, not a model.
 *   claude    the live adapter, with the same request building and server validation the worker uses.
 *
 * Writes a JSON report and a Markdown summary to evals/reports/.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeProvider, CLAUDE_PROMPT_VERSION } from "@/lib/ai/claude-adapter";
import type { ProviderResult, RecommendationProvider } from "@/lib/ai/provider";
import { SIGNAL_POLICY_VERSION, signalBand, validateRecommendation } from "@/lib/ai/validate-recommendation";
import type { RecommendationRequest } from "@/lib/contracts/recommendation";
import { classificationHash, clean } from "@/lib/domain/catalog-validation";
import { RETRIEVAL_POLICY_VERSION, retrieveCandidates } from "@/lib/retrieval/candidates";
import { evaluationTaxonomy, HELDOUT_STATUS, loadDataset, type Dataset, type EvalRecord, type Split } from "./corpus";
import { computeMetrics, highSignalGate, type ItemOutcome, type Metrics, type Rate } from "./metrics";

/** Deterministic lexical yardstick. Clearly not a model: it only restates what retrieval found. */
export class BaselineProvider implements RecommendationProvider {
  readonly id = "baseline";
  readonly isDemo = false;
  readonly modelId = null;
  readonly promptVersion = "baseline-unique-exact-v1";
  async recommend(request: RecommendationRequest): Promise<ProviderResult> {
    const exact = request.candidates.filter((c) => c.exactAlias);
    const pick = exact.length === 1 ? exact[0] : null;
    return {
      ok: true,
      usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
      payload: {
        listingRevisionId: request.listingRevisionId,
        taxonomyVersionId: request.taxonomyVersionId,
        selectedConceptId: pick?.conceptId ?? null,
        alternatives: [],
        evidence: pick ? pick.evidence.filter((e) => e.field !== "merchant_category_path").map((e) => ({ field: e.field, excerpt: e.excerpt, supportsConceptId: pick.conceptId })) : [],
        explanation: pick ? `The title contains the only exact name or synonym match: ${pick.name}.` : "No single exact name or synonym match.",
        ambiguityFlags: [],
        missingInformation: pick ? [] : ["No unique exact match in the title."],
        proposedConcept: null,
      },
    };
  }
}

const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const listingId = (i: number) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`;

export function requestFor(record: EvalRecord, index: number, taxonomy: ReturnType<typeof evaluationTaxonomy>): RecommendationRequest {
  const product = { title: clean(record.title), description: record.description ? clean(record.description) : null, merchantCategoryPath: record.merchantCategoryPath ? clean(record.merchantCategoryPath) : null, brand: record.brand, packageSize: record.packageSize, gtin: null };
  const candidates = retrieveCandidates(taxonomy.leaves, product);
  const parents = new Set(candidates.map((c) => taxonomy.leaves.find((l) => l.conceptId === c.conceptId)?.parentConceptId));
  const branches = taxonomy.branches.filter((b) => parents.has(b.conceptId) || b.path.split(" > ").length === 2).slice(0, 24);
  return { workspaceId: "evaluation", listingRevisionId: listingId(index), taxonomyVersionId: VERSION_ID, contentHash: classificationHash({ sku: record.id, ...product, price: null, currency: null }), product, truncatedFields: [], candidates, branches };
}

export async function evaluate(dataset: Dataset, provider: RecommendationProvider, options: { maxItems?: number; onItem?: (done: number, total: number) => void } = {}) {
  const taxonomy = evaluationTaxonomy();
  const records = options.maxItems ? dataset.records.slice(0, options.maxItems) : dataset.records;
  const outcomes: ItemOutcome[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  for (const [i, record] of records.entries()) {
    const request = requestFor(record, i, taxonomy);
    const candidateKeys = request.candidates.map((c) => c.stableKey);
    const result = await provider.recommend(request);
    usage.calls++;
    usage.inputTokens += result.usage?.inputTokens ?? 0;
    usage.outputTokens += result.usage?.outputTokens ?? 0;
    const base = { record, candidateKeys, selectedKey: null, evidenceCount: 0, band: null, valid: false };
    if (!result.ok) outcomes.push({ ...base, status: "failed", failureCode: `${result.failure.kind}:${result.failure.code}` });
    else {
      const validated = validateRecommendation(request, result.payload);
      if (!validated.ok) outcomes.push({ ...base, status: "failed", failureCode: `invalid:${validated.code}` });
      else {
        const r = validated.response;
        // The band is computed as if High were enabled, so its precision can be measured before it is.
        outcomes.push({ ...base, valid: true, status: r.selectedConceptId ? "selected" : "abstained", failureCode: null, selectedKey: r.selectedConceptId ? (taxonomy.keyOfId.get(r.selectedConceptId) ?? null) : null, evidenceCount: r.evidence.length, band: signalBand(request, r, true).band });
      }
    }
    options.onItem?.(i + 1, records.length);
  }
  return { outcomes, metrics: computeMetrics(outcomes), usage, evaluated: records.length };
}

const pct = (r: Rate) => (r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(1)}%`);
const row = (label: string, r: Rate, note = "") => `| ${label} | ${pct(r)} | ${r.hits}/${r.n} | ${note} |`;

export function markdownReport(meta: Record<string, unknown>, m: Metrics, gate: { met: boolean; reasons: string[] }): string {
  return [
    `# Evaluation report`,
    "",
    ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
    "",
    "| Measure | Result | Count | Note |",
    "| --- | --- | --- | --- |",
    row("Retrieval recall at 10", m.retrievalRecallAt10, "KPI01 target 95%. Labelable items only"),
    row("Top suggestion accuracy (strict)", m.top1Accuracy, "KPI02 target 85%. Abstentions and failures count as misses"),
    row("Top suggestion accuracy (lenient)", m.top1AccuracyLenient, "Also counts labeled acceptable alternatives"),
    row("Ranking accuracy when retrieved", m.rankingAccuracyGivenRetrieved, "Separates ranking from retrieval misses"),
    row("Correct abstention", m.abstention.correctAbstention, "Items where abstaining is right"),
    row("False selection", m.abstention.falseSelection, "Selected a leaf where abstaining is right"),
    row("Over-abstention", m.abstention.overAbstention, "Abstained on a labelable item"),
    row("Abstention rate", m.abstention.abstentionRate, "All items"),
    row("Evidence faithfulness", m.evidenceFaithfulness, "Responses passing server validation, including literal excerpts"),
    row("Selections citing evidence", m.selectionsWithEvidence),
    row("Provider failures", m.providerFailures, "Refusals, truncation, errors, invalid output"),
    row("High band precision", m.bands.high.precision, `KPI03 target 95%. Coverage ${pct(m.bands.high.coverage)}`),
    row("Medium band precision", m.bands.medium.precision, `Coverage ${pct(m.bands.medium.coverage)}`),
    row("Low band precision", m.bands.low.precision, `Coverage ${pct(m.bands.low.coverage)}`),
    "",
    "## Right outcome by issue type",
    "",
    "| Issue | Result | Count |",
    "| --- | --- | --- |",
    ...Object.entries(m.byIssue).map(([k, r]) => `| ${k} | ${pct(r)} | ${r.hits}/${r.n} |`),
    "",
    "## High signal gate",
    "",
    gate.met ? "**Met.** An administrator may enable the High band." : `**Not met.** The High band stays disabled.\n\n${gate.reasons.map((r) => `- ${r}`).join("\n")}`,
    "",
    m.retrievalMisses.length ? `Retrieval misses: ${m.retrievalMisses.join(", ")}` : "No retrieval misses.",
    "",
  ].join("\n");
}

async function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const split = (arg("split") ?? "development") as Split;
  const providerName = arg("provider") ?? "baseline";
  const maxItems = arg("max-items") ? Number(arg("max-items")) : undefined;
  const dataset = loadDataset(split);

  let provider: RecommendationProvider;
  if (providerName === "claude") {
    const key = process.env.ANTHROPIC_API_KEY;
    const model = process.env.AI_MODEL_ID;
    if (!key || !model) {
      console.error("The live evaluation needs ANTHROPIC_API_KEY and AI_MODEL_ID. Nothing was run.");
      process.exit(2);
    }
    if (!maxItems) {
      console.error("Pass --max-items to bound the cost of a live evaluation. Nothing was run.");
      process.exit(2);
    }
    provider = new ClaudeProvider(model, { apiKey: key });
  } else if (providerName === "baseline") provider = new BaselineProvider();
  else throw new Error(`Unknown provider "${providerName}". Use baseline or claude.`);

  const { metrics, usage, evaluated } = await evaluate(dataset, provider, { maxItems, onItem: (done, total) => done % 25 === 0 && console.error(`${done}/${total}`) });
  const inspected = split === "heldout" && HELDOUT_STATUS.inspected;
  const gate = highSignalGate({ split, provider: provider.id, expertLabeled: dataset.labeling.expert, items: dataset.records.length, metrics, inspected });
  const meta = {
    split,
    "dataset version": dataset.version,
    "items evaluated": `${evaluated} of ${dataset.records.length}`,
    labeling: dataset.labeling.expert === dataset.records.length ? "expert" : `PRELIMINARY: ${dataset.labeling.provisional} of ${dataset.records.length} labels are provisional (written by the model that built this application, not by an independent expert)`,
    "set status": split === "heldout" ? (inspected ? `INSPECTED since ${HELDOUT_STATUS.since}: not an untouched evaluation. ${HELDOUT_STATUS.reason} Use the development set for tuning; a new reserved set is needed for independent assessment` : "untouched") : "development set, used for tuning",
    provider: provider.id,
    model: provider.modelId ?? "none (deterministic)",
    "prompt version": provider.id === "claude" ? CLAUDE_PROMPT_VERSION : provider.promptVersion,
    "retrieval policy": RETRIEVAL_POLICY_VERSION,
    "signal policy": SIGNAL_POLICY_VERSION,
    "provider usage": provider.id === "claude" ? `${usage.calls} calls, ${usage.inputTokens} input and ${usage.outputTokens} output tokens` : "none",
    generated: new Date().toISOString(),
  };
  const dir = resolve(process.cwd(), "evals/reports");
  mkdirSync(dir, { recursive: true });
  const name = `${split}-${provider.id}`;
  writeFileSync(resolve(dir, `${name}.json`), JSON.stringify({ meta, metrics, gate }, null, 2) + "\n");
  const md = markdownReport(meta, metrics, gate);
  writeFileSync(resolve(dir, `${name}.md`), md);
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
