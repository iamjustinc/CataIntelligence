/**
 * Live provider smoke test. Separately budgeted and never part of `pnpm test`.
 *
 *   pnpm smoke:live --input-price <USD per million input tokens> --output-price <USD per million output tokens> [--budget 2]
 *
 * Needs AI_MODEL_ID and the key of the configured provider (OPENAI_API_KEY, or ANTHROPIC_API_KEY
 * with AI_PROVIDER=anthropic). Sends three fictional listings through the real recommendation
 * adapter and two fictional questions through the real analytics planner, with the same server
 * validation the application applies, and prints what happened and the actual token usage.
 *
 * The budget is enforced by this script, not trusted to the provider: before every call it adds
 * the worst case that call could cost (its output-token ceiling plus a generous input allowance)
 * to what has been spent, and stops if that would exceed the budget. Prices are arguments because
 * the application never assumes a provider's prices.
 *
 * It exits with code 2 and makes no call when credentials or prices are missing, so its absence of
 * output can never be mistaken for a successful live verification.
 */
import "dotenv/config";
import { ClaudeProvider } from "@/lib/ai/claude-adapter";
import { liveProvider } from "@/lib/ai/live";
import { OpenAIProvider } from "@/lib/ai/openai-adapter";
import { signalBand, validateRecommendation } from "@/lib/ai/validate-recommendation";
import { ClaudePlanner } from "@/lib/analytics/claude-planner";
import { OpenAIPlanner } from "@/lib/analytics/openai-planner";
import { evaluationTaxonomy, loadDataset } from "@/evals/corpus";
import { requestFor } from "@/evals/run";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
/** Worst case assumed for one call when deciding whether it still fits the budget. */
const WORST_CASE = { recommendation: { input: 6_000, output: 8_000 }, plan: { input: 6_000, output: 4_000 } };

async function main() {
  const live = liveProvider();
  const model = process.env.AI_MODEL_ID;
  const [inputPrice, outputPrice, budget] = [Number(arg("input-price")), Number(arg("output-price")), Number(arg("budget") ?? 2)];
  if (!live.apiKey || !model) {
    console.error(`Live smoke test NOT RUN: ${live.keyVariable} and AI_MODEL_ID are required. No provider call was made.`);
    process.exit(2);
  }
  if (!(inputPrice > 0) || !(outputPrice > 0) || !(budget > 0)) {
    console.error("Live smoke test NOT RUN: pass --input-price and --output-price (USD per million tokens) so the budget can be enforced. No provider call was made.");
    process.exit(2);
  }
  const cost = (input: number, output: number) => (input * inputPrice + output * outputPrice) / 1_000_000;
  let spent = 0;
  let input = 0;
  let output = 0;
  let calls = 0;
  const affordable = (kind: keyof typeof WORST_CASE) => spent + cost(WORST_CASE[kind].input, WORST_CASE[kind].output) <= budget;
  const record = (usage: { inputTokens: number | null; outputTokens: number | null } | null, kind: keyof typeof WORST_CASE) => {
    calls++;
    // A call whose usage is unknown is charged at its worst case, never at zero.
    const [i, o] = [usage?.inputTokens ?? WORST_CASE[kind].input, usage?.outputTokens ?? WORST_CASE[kind].output];
    input += i;
    output += o;
    spent += cost(i, o);
  };
  console.log(`Provider ${live.label}, model ${model}. Budget USD ${budget.toFixed(2)} at ${inputPrice}/${outputPrice} USD per million input/output tokens.`);

  const provider = live.name === "openai" ? new OpenAIProvider(model, { apiKey: live.apiKey }) : new ClaudeProvider(model, { apiKey: live.apiKey });
  const taxonomy = evaluationTaxonomy();
  const records = loadDataset("development").records.filter((r) => ["dev-cottage-cheese", "dev-water-sparse", "dev-carrots-injection"].includes(r.id));
  let passed = 0;
  let stopped = false;
  for (const [i, item] of records.entries()) {
    if (!affordable("recommendation")) {
      stopped = true;
      break;
    }
    const request = requestFor(item, i, taxonomy);
    const result = await provider.recommend(request);
    record(result.usage, "recommendation");
    if (!result.ok) {
      console.log(`${item.id}: provider failure ${result.failure.kind}/${result.failure.code}`);
      if (result.failure.kind === "fatal") break;
      continue;
    }
    const validated = validateRecommendation(request, result.payload);
    if (!validated.ok) {
      console.log(`${item.id}: response rejected by server validation (${validated.code}: ${validated.message})`);
      continue;
    }
    passed++;
    const selected = validated.response.selectedConceptId ? taxonomy.keyOfId.get(validated.response.selectedConceptId) : null;
    console.log(`${item.id}: valid response; selected ${selected ?? "nothing (abstained)"}; band ${signalBand(request, validated.response, false).band}; expected ${item.label.conceptKey ?? "abstention"}`);
  }
  console.log(`Recommendations: ${passed} of ${records.length} returned a response that passed server validation.`);

  // Analytics planner: one answerable question and one that must be clarified. Fictional vocabulary only.
  const planner = live.name === "openai" ? new OpenAIPlanner(model, { apiKey: live.apiKey }) : new ClaudePlanner(model, { apiKey: live.apiKey });
  const vocabulary = { timezone: "UTC", merchants: [{ id: "11111111-1111-4111-8111-111111111111", name: "Harbor Market" }, { id: "22222222-2222-4222-8222-222222222222", name: "Daily Basket" }], branches: [{ key: "GRO", name: "Grocery" }] };
  const questions: [string, (kind: string, metric: string | null) => boolean][] = [
    ["How many listings are still waiting for review at each merchant?", (kind, metric) => kind === "spec" && metric === "pending_review_count"],
    ["What is our coverage?", (kind) => kind === "clarify"],
  ];
  let planned = 0;
  for (const [question, expected] of questions) {
    if (stopped || !affordable("plan")) {
      stopped = true;
      break;
    }
    const { outcome, usage } = await planner.plan({ question, previousSpec: null, vocabulary, now: new Date() });
    record(usage, "plan");
    const metric = outcome.kind === "spec" ? outcome.spec.metricIds[0] : null;
    const ok = usage.status === "ok" && expected(outcome.kind, metric);
    if (ok) planned++;
    console.log(`planner "${question}": ${usage.status}${usage.errorCode ? ` (${usage.errorCode})` : ""}; outcome ${outcome.kind}${metric ? ` ${metric}` : ""}; ${ok ? "as expected" : "NOT as expected"}`);
  }
  console.log(`Analytics planner: ${planned} of ${questions.length} interpretations were valid and as expected.`);
  console.log(`${calls} provider calls. Actual usage: ${input} input and ${output} output tokens. Cost at the stated prices: USD ${spent.toFixed(4)} of ${budget.toFixed(2)}.${stopped ? " STOPPED EARLY: the next call could have exceeded the budget." : ""}`);
  process.exit(!stopped && passed === records.length && planned === questions.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
