/**
 * Live provider smoke test. Separately budgeted and never part of `pnpm test`.
 *
 *   pnpm smoke:live            (needs ANTHROPIC_API_KEY and AI_MODEL_ID in the environment)
 *
 * Sends a small, fixed number of fictional listings through the real recommendation adapter and
 * two fictional questions through the real analytics planner, with the same server validation
 * the application applies, then prints what happened and the actual token usage. It exits
 * with code 2 and makes no call when credentials are missing, so its absence of output can never
 * be mistaken for a successful live verification.
 */
import "dotenv/config";
import { ClaudeProvider } from "@/lib/ai/claude-adapter";
import { ClaudePlanner } from "@/lib/analytics/claude-planner";
import { signalBand, validateRecommendation } from "@/lib/ai/validate-recommendation";
import { evaluationTaxonomy, loadDataset } from "@/evals/corpus";
import { requestFor } from "@/evals/run";

const MAX_CALLS = 3;

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.AI_MODEL_ID;
  if (!key || !model) {
    console.error("Live smoke test NOT RUN: ANTHROPIC_API_KEY and AI_MODEL_ID are required. No provider call was made.");
    process.exit(2);
  }
  const provider = new ClaudeProvider(model, { apiKey: key });
  const taxonomy = evaluationTaxonomy();
  const records = loadDataset("development").records.filter((r) => ["dev-cottage-cheese", "dev-water-sparse", "dev-carrots-injection"].includes(r.id)).slice(0, MAX_CALLS);
  let passed = 0;
  let input = 0;
  let output = 0;
  for (const [i, record] of records.entries()) {
    const request = requestFor(record, i, taxonomy);
    const result = await provider.recommend(request);
    input += result.usage?.inputTokens ?? 0;
    output += result.usage?.outputTokens ?? 0;
    if (!result.ok) {
      console.log(`${record.id}: provider failure ${result.failure.kind}/${result.failure.code}`);
      continue;
    }
    const validated = validateRecommendation(request, result.payload);
    if (!validated.ok) {
      console.log(`${record.id}: response rejected by server validation (${validated.code}: ${validated.message})`);
      continue;
    }
    passed++;
    const selected = validated.response.selectedConceptId ? taxonomy.keyOfId.get(validated.response.selectedConceptId) : null;
    console.log(`${record.id}: valid response; selected ${selected ?? "nothing (abstained)"}; band ${signalBand(request, validated.response, false).band}; expected ${record.label.conceptKey ?? "abstention"}`);
  }
  console.log(`\nRecommendations, model ${model}: ${passed} of ${records.length} calls returned a response that passed server validation. Actual usage: ${input} input and ${output} output tokens.`);

  // Analytics planner: one answerable question and one that must be clarified. Fictional vocabulary only.
  const planner = new ClaudePlanner(model, { apiKey: key });
  const vocabulary = { timezone: "UTC", merchants: [{ id: "11111111-1111-4111-8111-111111111111", name: "Harbor Market" }, { id: "22222222-2222-4222-8222-222222222222", name: "Daily Basket" }], branches: [{ key: "GRO", name: "Grocery" }] };
  const questions: [string, (kind: string, metric: string | null) => boolean][] = [
    ["How many listings are still waiting for review at each merchant?", (kind, metric) => kind === "spec" && metric === "pending_review_count"],
    ["What is our coverage?", (kind) => kind === "clarify"],
  ];
  let planned = 0;
  for (const [question, expected] of questions) {
    const { outcome, usage } = await planner.plan({ question, previousSpec: null, vocabulary, now: new Date() });
    input += usage.inputTokens ?? 0;
    output += usage.outputTokens ?? 0;
    const metric = outcome.kind === "spec" ? outcome.spec.metricIds[0] : null;
    const ok = usage.status === "ok" && expected(outcome.kind, metric);
    if (ok) planned++;
    console.log(`planner "${question}": ${usage.status}${usage.errorCode ? ` (${usage.errorCode})` : ""}; outcome ${outcome.kind}${metric ? ` ${metric}` : ""}; ${ok ? "as expected" : "NOT as expected"}`);
  }
  console.log(`Analytics planner, model ${model}: ${planned} of ${questions.length} interpretations were valid and as expected. Total actual usage: ${input} input and ${output} output tokens.`);
  process.exit(passed === records.length && planned === questions.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
