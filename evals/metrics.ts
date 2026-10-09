/**
 * Evaluation metrics (PRD 2.2, 13.5). Retrieval, ranking, abstention, evidence faithfulness and
 * signal-band precision are computed and reported separately, each with its sample size.
 */
import type { SignalDecision } from "@/lib/ai/validate-recommendation";
import type { EvalRecord } from "./corpus";

export interface ItemOutcome {
  record: EvalRecord;
  /** Stable keys of the retrieved candidates, best first. */
  candidateKeys: string[];
  /** What the provider did. `failed` covers refusals, truncation, provider errors and invalid output. */
  status: "selected" | "abstained" | "failed";
  selectedKey: string | null;
  failureCode: string | null;
  /** The response passed server validation, including literal evidence excerpts. */
  valid: boolean;
  evidenceCount: number;
  band: SignalDecision["band"] | null;
}

export interface Rate {
  n: number;
  hits: number;
  /** null when n is zero: not applicable, never reported as zero. */
  rate: number | null;
}
const rate = (hits: number, n: number): Rate => ({ n, hits, rate: n === 0 ? null : hits / n });

export interface Metrics {
  items: number;
  labelable: number;
  shouldAbstain: number;
  /** KPI01. The correct leaf is among the retrieved candidates, over labelable items. */
  retrievalRecallAt10: Rate;
  /** A retrieval miss is counted here and not blamed on ranking. */
  retrievalMisses: string[];
  /** KPI02. Selected leaf equals the labeled leaf, over labelable items. Abstentions and failures count as misses. */
  top1Accuracy: Rate;
  /** Same, but an `acceptable` leaf also counts. Reported for context, never as the headline. */
  top1AccuracyLenient: Rate;
  /** Ranking only: top-1 accuracy over labelable items whose correct leaf was retrieved. */
  rankingAccuracyGivenRetrieved: Rate;
  abstention: {
    /** Items that should be abstained on and were. */
    correctAbstention: Rate;
    /** Items that should be abstained on but got a selection (the costly error). */
    falseSelection: Rate;
    /** Labelable items the provider abstained on. */
    overAbstention: Rate;
    /** Share of all items with no selection. */
    abstentionRate: Rate;
  };
  /** Responses that passed validation, over responses received (failures excluded). */
  evidenceFaithfulness: Rate;
  /** Selections that cite at least one literal excerpt. */
  selectionsWithEvidence: Rate;
  providerFailures: Rate;
  /** KPI03 and the other bands: precision among selections placed in the band, with coverage. */
  bands: Record<"high" | "medium" | "low", { precision: Rate; coverage: Rate }>;
  byIssue: Record<string, Rate>;
  byDomain: Record<string, Rate>;
}

/** A selection is correct only when the item is labelable and the selection is the labeled leaf. */
const correct = (o: ItemOutcome) => o.status === "selected" && o.record.label.conceptKey !== null && o.selectedKey === o.record.label.conceptKey;
/** Right outcome for any item: the labeled leaf, or abstention where abstention is correct. */
const rightOutcome = (o: ItemOutcome) => (o.record.label.conceptKey === null ? o.status === "abstained" : correct(o));

export function computeMetrics(outcomes: ItemOutcome[]): Metrics {
  const labelable = outcomes.filter((o) => o.record.label.conceptKey !== null);
  const abstainers = outcomes.filter((o) => o.record.label.conceptKey === null);
  const retrieved = labelable.filter((o) => o.candidateKeys.includes(o.record.label.conceptKey!));
  const responded = outcomes.filter((o) => o.status !== "failed" || o.failureCode?.startsWith("invalid:"));
  const selections = outcomes.filter((o) => o.status === "selected");
  const band = (b: "high" | "medium" | "low") => {
    const inBand = selections.filter((o) => o.band === b);
    return { precision: rate(inBand.filter(correct).length, inBand.length), coverage: rate(inBand.length, outcomes.length) };
  };
  const group = (key: (o: ItemOutcome) => string[]) => {
    const out: Record<string, Rate> = {};
    const names = [...new Set(outcomes.flatMap(key))].sort();
    for (const name of names) {
      const subset = outcomes.filter((o) => key(o).includes(name));
      out[name] = rate(subset.filter(rightOutcome).length, subset.length);
    }
    return out;
  };
  return {
    items: outcomes.length,
    labelable: labelable.length,
    shouldAbstain: abstainers.length,
    retrievalRecallAt10: rate(retrieved.length, labelable.length),
    retrievalMisses: labelable.filter((o) => !retrieved.includes(o)).map((o) => o.record.id),
    top1Accuracy: rate(labelable.filter(correct).length, labelable.length),
    top1AccuracyLenient: rate(labelable.filter((o) => correct(o) || (o.status === "selected" && o.record.label.acceptable.includes(o.selectedKey!))).length, labelable.length),
    rankingAccuracyGivenRetrieved: rate(retrieved.filter(correct).length, retrieved.length),
    abstention: {
      correctAbstention: rate(abstainers.filter((o) => o.status === "abstained").length, abstainers.length),
      falseSelection: rate(abstainers.filter((o) => o.status === "selected").length, abstainers.length),
      overAbstention: rate(labelable.filter((o) => o.status === "abstained").length, labelable.length),
      abstentionRate: rate(outcomes.filter((o) => o.status === "abstained").length, outcomes.length),
    },
    evidenceFaithfulness: rate(responded.filter((o) => o.valid).length, responded.length),
    selectionsWithEvidence: rate(selections.filter((o) => o.evidenceCount > 0).length, selections.length),
    providerFailures: rate(outcomes.filter((o) => o.status === "failed").length, outcomes.length),
    bands: { high: band("high"), medium: band("medium"), low: band("low") },
    byIssue: group((o) => (o.record.label.issues.length ? o.record.label.issues : ["none"])),
    byDomain: group((o) => [o.record.domain]),
  };
}

export const HIGH_GATE = { minPrecision: 0.95, minSelections: 50 } as const;

/** 95% Wilson score interval for a proportion. Null when there are no trials. */
export function wilson(hits: number, n: number): { low: number; high: number } | null {
  if (n === 0) return null;
  const z = 1.959964;
  const p = hits / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const denominator = 1 + (z * z) / n;
  return { low: Math.max(0, (centre - margin) / denominator), high: Math.min(1, (centre + margin) / denominator) };
}

export interface GateDecision {
  met: boolean;
  reasons: string[];
}

/**
 * Whether the High signal band may be enabled (PRD TAX07, KPI03). It requires a live model, the
 * frozen split (evals/PROTOCOL.md), independent expert labels and enough High selections at 95% precision. This
 * function only reports; nothing in the application enables the band automatically.
 */
export function highSignalGate(input: { split: string; provider: string; expertLabeled: number; items: number; metrics: Metrics; /** The evaluated set was looked at before this run. */ inspected?: boolean }): GateDecision {
  const reasons: string[] = [];
  const { precision } = input.metrics.bands.high;
  if (input.split !== "frozen") reasons.push("The gate is evaluated on the frozen test set only (evals/PROTOCOL.md). Development and inspected sets cannot open it.");
  if (input.inspected) reasons.push("This set has been inspected, so it is development data, not an untouched evaluation.");
  if (input.provider !== "claude" && input.provider !== "openai") reasons.push("The gate requires results from the live model, not a baseline or fixture provider.");
  if (input.expertLabeled < input.items) reasons.push(`${input.items - input.expertLabeled} of ${input.items} records are not independently expert-labeled.`);
  if (precision.n < HIGH_GATE.minSelections) reasons.push(`Only ${precision.n} High selections; at least ${HIGH_GATE.minSelections} are needed for a meaningful precision estimate.`);
  if (precision.rate === null || precision.rate < HIGH_GATE.minPrecision) reasons.push(`High precision is ${precision.rate === null ? "not applicable" : `${(precision.rate * 100).toFixed(1)}%`}; the target is at least ${HIGH_GATE.minPrecision * 100}%.`);
  return { met: reasons.length === 0, reasons };
}
